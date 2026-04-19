import { internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";

/**
 * Safety-net sweep for meetings stuck in "scheduled" status past their end time.
 *
 * The primary overran detection is a one-shot `scheduler.runAt` per meeting
 * (see `attendanceChecks.ts`). This sweep runs on a cron to catch meetings
 * where that scheduled check was never queued, failed silently, or the meeting
 * predates the attendance-check feature.
 *
 * Grace period: only flags meetings that have been past their end time for at
 * least SWEEP_GRACE_MS, so the normal one-shot check has a chance to fire first.
 *
 * Idempotent: `checkMeetingAttendance` is a no-op if the meeting has already
 * transitioned away from "scheduled" or already has a linked review.
 */

const SWEEP_GRACE_MS = 5 * 60_000; // 5 minutes after meeting end time
const BATCH_SIZE = 100;

export const sweepStaleMeetings = internalMutation({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();

		// Collect active tenant IDs
		const tenantIds = [];
		for await (const tenant of ctx.db
			.query("tenants")
			.withIndex("by_status", (q) => q.eq("status", "active"))) {
			tenantIds.push(tenant._id);
		}

		let scheduled = 0;

		for (const tenantId of tenantIds) {
			// Query meetings still in "scheduled" status with scheduledAt in the past.
			// The index filters on (tenantId, status, scheduledAt < now).
			const candidates = await ctx.db
				.query("meetings")
				.withIndex("by_tenantId_and_status_and_scheduledAt", (q) =>
					q
						.eq("tenantId", tenantId)
						.eq("status", "scheduled")
						.lt("scheduledAt", now),
				)
				.take(BATCH_SIZE);

			for (const meeting of candidates) {
				const meetingEndTime =
					meeting.scheduledAt + meeting.durationMinutes * 60_000;

				// Only flag if we're past the end time + grace period
				if (now > meetingEndTime + SWEEP_GRACE_MS) {
					await ctx.scheduler.runAfter(
						0,
						internal.closer.meetingOverrun.checkMeetingAttendance,
						{ meetingId: meeting._id },
					);
					scheduled++;
				}
			}
		}

		if (scheduled > 0) {
			console.log(
				"[MeetingOverrun:Sweep] Scheduled attendance checks for stale meetings",
				{
					tenantCount: tenantIds.length,
					meetingsScheduled: scheduled,
				},
			);
		}
	},
});
