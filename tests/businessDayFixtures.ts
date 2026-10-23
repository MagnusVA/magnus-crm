import { vi } from "vitest";
import { bookingHarness, qualifiedLifecycle } from "./bookingHarness";
import { requestMeetingProjection } from "../convex/operations/meetingStats";
import { updateLeadGenDailyStats, updateLeadGenOriginStats, updateLeadGenTeamOriginStats } from "../convex/leadGen/aggregates";
import { normalizeLeadGenOrigin } from "../convex/leadGen/normalization";
import { insertPayment, insertProgram } from "./enrollmentFixtures";

export async function businessDayFixture() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
  const h = await bookingHarness({ transactionLimits: true });
  const fixture = await h.t.run(async ctx => {
    const tenantId = h.tenantId;
    await ctx.db.patch("tenants", tenantId, { meetingProjectionVersion: 2 });
    const users = await ctx.db.query("users").withIndex("by_tenantId", q => q.eq("tenantId", tenantId)).take(10);
    const admin = users.find(user => user.role === "tenant_admin")!;
    const closer = users.find(user => user.role === "closer")!;
    const leadId = await ctx.db.insert("leads", { tenantId, ...qualifiedLifecycle(0), status: "active", firstSeenAt: 0, updatedAt: 0 });
    const opportunityId = await ctx.db.insert("opportunities", { tenantId, leadId, assignedCloserId: closer._id, stage: "booked", outcome: "open", source: "calendly", createdAt: 0, updatedAt: 0 });
    const meetingId = await ctx.db.insert("meetings", { tenantId, opportunityId, assignedCloserId: closer._id, scheduledAt: Date.parse("2026-10-01T02:00Z"), durationMinutes: 30, status: "held", heldMarkedAt: Date.parse("2026-10-01T03:00Z"), createdAt: 0, calendlyEventUri: "business-day", calendlyInviteeUri: "business-day-invitee" });
    await requestMeetingProjection(ctx, tenantId, meetingId);
    const teamId = await ctx.db.insert("attributionTeams", { tenantId, slug: "day-team", displayName: "Day team", utmSource: "day-team", normalizedUtmSource: "day-team", isActive: true, createdAt: 0, updatedAt: 0 });
    const workers = [];
    for (const user of [admin, closer]) {
      const workerId = await ctx.db.insert("leadGenWorkers", { tenantId, userId: user._id, workosUserId: user.workosUserId, email: user.email, teamId, isActive: true, createdAt: 0, updatedAt: 0 });
      workers.push((await ctx.db.get("leadGenWorkers", workerId))!);
      await ctx.db.insert("leadGenWorkerSchedules", { tenantId, workerId, userId: user._id, weekday: "thursday", scheduledHours: 8, updatedByUserId: admin._id, updatedAt: 0 });
    }
    const prospects = [];
    for (const handle of ["alpha", "beta", "voided"]) {
      prospects.push(await ctx.db.insert("leadGenProspects", { tenantId, leadId, firstSource: "instagram", latestSource: "instagram", dedupeKey: `instagram:${handle}`, normalizedHandle: handle, rawHandle: handle, profileUrl: `https://instagram.com/${handle}`, firstCapturedByWorkerId: workers[0]._id, firstCapturedAt: 0, lastSubmittedByWorkerId: workers[0]._id, lastSubmittedAt: 0, latestOriginKind: "reel", contactAttemptCount: 1, distinctWorkerCount: 1, createdAt: 0, updatedAt: 0 }));
    }
    const origin = normalizeLeadGenOrigin({ originKind: "reel", originUrlOrLabel: "https://instagram.com/reel/daytest/" });
    const submissionIds = [];
    for (const [index, at] of ["2026-10-01T06:30Z", "2026-10-01T07:30Z", "2026-10-02T06:00Z", "2026-10-01T08:00Z"].entries()) {
      const worker = workers[index === 1 ? 1 : 0];
      const prospectId = prospects[index <= 1 ? 0 : index - 1];
      const submittedAt = Date.parse(at);
      const voidedAt = index === 3 ? submittedAt + 1 : undefined;
      submissionIds.push(await ctx.db.insert("leadGenSubmissions", { tenantId, workerId: worker._id, userId: worker.userId, teamId, prospectId, source: "instagram", originKind: "reel", originValue: origin.originValue, originRankable: true, submittedAt, createdAt: submittedAt, voidedAt }));
      if (voidedAt !== undefined) continue;
      await updateLeadGenDailyStats(ctx, { tenantId, worker, prospectId, source: "instagram", submittedAt, duplicateProspectSubmission: index === 1 });
      const args = { tenantId, teamId, prospectId, source: "instagram" as const, originKind: "reel" as const, originKey: origin.originKey!, originValue: origin.originValue!, submittedAt };
      await updateLeadGenOriginStats(ctx, args);
      await updateLeadGenTeamOriginStats(ctx, args);
    }
    const programId = await insertProgram(ctx, tenantId, "Day program");
    await insertPayment(ctx, { tenantId, opportunityId, programId, recordedAt: Date.parse("2026-10-01T02:00Z") });
    return { meetingId, submissionIds, workerId: workers[0]._id, adminId: admin._id, opportunityId };
  });
  await h.t.finishAllScheduledFunctions(vi.runAllTimers);
  vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
  return { ...h, ...fixture };
}
