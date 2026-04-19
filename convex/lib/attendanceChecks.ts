import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export function getMeetingAttendanceCheckTimestamp(
	scheduledAt: number,
	durationMinutes: number,
): number {
	return scheduledAt + durationMinutes * 60_000 + 60_000;
}

export async function scheduleMeetingAttendanceCheck(
	ctx: MutationCtx,
	meetingId: Id<"meetings">,
	scheduledAt: number,
	durationMinutes: number,
): Promise<Id<"_scheduled_functions">> {
	return await ctx.scheduler.runAt(
		getMeetingAttendanceCheckTimestamp(scheduledAt, durationMinutes),
		internal.closer.meetingOverrun.checkMeetingAttendance,
		{ meetingId },
	);
}

export async function cancelMeetingAttendanceCheck(
	ctx: MutationCtx,
	attendanceCheckId: Id<"_scheduled_functions"> | undefined,
	context: string,
): Promise<void> {
	if (!attendanceCheckId) {
		return;
	}

	try {
		await ctx.scheduler.cancel(attendanceCheckId);
	} catch (error) {
		console.warn("[AttendanceCheck] Unable to cancel scheduled check", {
			context,
			attendanceCheckId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
