import { convexTest } from "convex-test";
import type { Doc } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { convexTestModules } from "../convex/test.setup";
import { qualifiedLifecycle } from "./bookingHarness";
import { businessDayStart, DEFAULT_BUSINESS_DAY } from "../lib/businessDay";

export const DAY = 86_400_000;
export const from = businessDayStart("2026-09-28", DEFAULT_BUSINESS_DAY);
export const split = from + DAY, to = split + DAY;
export const range = { fromMs: from, toMs: to, startDate: "2026-09-28", endDateInclusive: "2026-09-29", ...DEFAULT_BUSINESS_DAY };
export const identity = { subject: "admin", org_id: "org_c" };

export async function createRoleFixture() {
  const t = convexTest({ schema, modules: convexTestModules, transactionLimits: true });
  const fixture = await t.run(async ctx => {
    const tenantId = await ctx.db.insert("tenants", { companyName: "Reports", contactEmail: "reports@example.invalid",
      workosOrgId: "org_c", status: "active", inviteExpiresAt: to, createdBy: "test" });
    const memberA = await ctx.db.insert("teamMembers", { tenantId, displayName: "A", createdAt: 0, updatedAt: 0 });
    const memberB = await ctx.db.insert("teamMembers", { tenantId, displayName: "B", createdAt: 0, updatedAt: 0 });
    const memberIdle = await ctx.db.insert("teamMembers", { tenantId, displayName: "Idle", createdAt: 0, updatedAt: 0 });
    const admin = await ctx.db.insert("users", { tenantId, workosUserId: "admin", email: "admin@example.invalid", role: "tenant_admin", isActive: true });
    const closerA = await ctx.db.insert("users", { tenantId, workosUserId: "a", email: "a@example.invalid", role: "closer", isActive: true, teamMemberId: memberA });
    const closerB = await ctx.db.insert("users", { tenantId, workosUserId: "b", email: "b@example.invalid", role: "lead_generator", isActive: true, teamMemberId: memberB });
    const teamId = await ctx.db.insert("attributionTeams", { tenantId, slug: "team", displayName: "DM team", utmSource: "team",
      normalizedUtmSource: "team", isActive: true, createdAt: 0, updatedAt: 0 });
    const programId = await ctx.db.insert("tenantPrograms", { tenantId, name: "Program", normalizedName: "program", createdAt: 0, updatedAt: 0, createdByUserId: admin });
    const leadId = await ctx.db.insert("leads", { tenantId, fullName: "Person", ...qualifiedLifecycle(0), status: "active", firstSeenAt: 0, updatedAt: 0 });
    const dealId = await ctx.db.insert("opportunities", { tenantId, leadId, stage: "closed", outcome: "won", firstBookedAt: from,
      assignedCloserId: closerB, createdAt: from - DAY, updatedAt: to });
    const installationId = await ctx.db.insert("slackInstallations", { tenantId, teamId: "T", teamName: "Team", isEnterpriseInstall: false,
      appId: "A", botUserId: "BOT", botAccessToken: "test", scopes: [], installedByWorkosUserId: "admin", installedAt: 0,
      tokenExpiresAt: 0, refreshToken: "test", status: "active" });
    const workerA = await ctx.db.insert("leadGenWorkers", { tenantId, userId: closerA, workosUserId: "a", email: "a@example.invalid", teamId,
      teamMemberId: memberA, isActive: true, createdAt: 0, updatedAt: 0 });
    const workerB = await ctx.db.insert("leadGenWorkers", { tenantId, userId: closerB, workosUserId: "b", email: "b@example.invalid", teamId,
      teamMemberId: memberB, isActive: false, createdAt: 0, updatedAt: 0 });
    for (const [slackUserId, member] of [["UA", memberA], ["UB", memberB], ["UI", memberIdle], ["UNLINKED", undefined]] as const) {
      await ctx.db.insert("slackUsers", { tenantId, installationId, slackUserId, slackTeamId: "T", teamMemberId: member,
        isBot: false, isDeleted: false, firstSeenAt: 0, lastSeenAt: 0, lastSyncedAt: 0 });
    }
    const dmA = await ctx.db.insert("dmClosers", { tenantId, teamId, slug: "a", displayName: "A", utmMedium: "a",
      normalizedUtmMedium: "a", isActive: true, createdAt: 0, updatedAt: 0, teamMemberId: memberA });
    const meeting = (fields: Partial<Doc<"meetings">> = {}) => ctx.db.insert("meetings", {
      tenantId, opportunityId: dealId, assignedCloserId: closerB, calendlyEventUri: "event", calendlyInviteeUri: "invitee",
      scheduledAt: from + 3_600_000, durationMinutes: 30, status: "held", leadName: "Booking person", createdAt: from + 100, ...fields });
    const meetingA = await meeting();
    const meetingB = await meeting({ createdAt: split + 100, scheduledAt: split + 3_600_000, status: "no_show" });
    const replacement = await meeting({ createdAt: split + 200, scheduledAt: to + DAY, status: "scheduled", rescheduledFromMeetingId: meetingB });
    const teamOnly = await meeting({ createdAt: split + 300, status: "scheduled", scheduledAt: from + 3_600_000 });
    const moved = await meeting({ status: "canceled", createdAt: from + 50 });
    await meeting({ rescheduledFromMeetingId: moved, createdAt: split + 400 });
    const prospectId = await ctx.db.insert("leadGenProspects", { tenantId, firstSource: "instagram", latestSource: "instagram", dedupeKey: "person",
      normalizedHandle: "person", rawHandle: "person", profileUrl: "url", firstCapturedByWorkerId: workerA, firstCapturedAt: from,
      lastSubmittedByWorkerId: workerA, lastSubmittedAt: split, latestOriginKind: "follower", contactAttemptCount: 2,
      distinctWorkerCount: 1, leadId, createdAt: from, updatedAt: split });
    const eventId = await ctx.db.insert("domainEvents", { tenantId, entityType: "lead", entityId: leadId, eventType: "lead.captured", occurredAt: from, source: "system" });
    const batchId = await ctx.db.insert("resparkBatches", { tenantId, userId: closerA, workerId: workerA, createdAt: from, heldUntil: to, size: 1, requestedSize: 1 });
    const itemId = await ctx.db.insert("resparkBatchItems", { tenantId, batchId, userId: closerA, workerId: workerA, leadId,
      position: 0, bucket: 1, heldUntil: to, result: "resparked", workedAt: split + 500 });
    // Worked without a respark: they don't count as resparks.
    for (const result of ["skipped", "not_a_fit"] as const) {
      await ctx.db.insert("resparkBatchItems", { tenantId, batchId, userId: closerA, workerId: workerA, leadId,
        position: 1, bucket: 1, heldUntil: to, result, workedAt: split + 600 });
    }
    const credit = (fields: Pick<Doc<"dealAttributions">, "role" | "source"> & Partial<Doc<"dealAttributions">>) =>
      ctx.db.insert("dealAttributions", { tenantId, opportunityId: dealId, teamMemberId: memberA, attributedAt: from, createdAt: from, ...fields });
    await credit({ role: "lead_gen", source: { kind: "capture", prospectId, workerId: workerA, eventId } });
    await credit({ role: "lead_gen", teamMemberId: memberB, source: { kind: "capture", prospectId, workerId: workerB, eventId } });
    await credit({ role: "lead_gen", attributedAt: split + 500, source: { kind: "respark", itemId, workerId: workerA, eventId } });
    await credit({ role: "setter", source: { kind: "slack_qualification", slackUserId: "UA" } });
    await credit({ role: "setter", attributedAt: split + 10, source: { kind: "slack_qualification", slackUserId: "UA" } });
    await credit({ role: "setter", teamMemberId: memberB, attributedAt: split + 10, source: { kind: "slack_qualification", slackUserId: "UB" } });
    await credit({ role: "setter", teamMemberId: undefined, source: { kind: "slack_qualification", slackUserId: "UNLINKED" } });
    for (const id of [meetingA, meetingB, replacement]) {
      const doc = (await ctx.db.get("meetings", id))!;
      await credit({ role: "dm_closer", meetingId: id, attributedAt: doc.createdAt, source: { kind: "booking_utm", dmCloserId: dmA } });
    }
    await credit({ role: "dm_team", meetingId: teamOnly, teamMemberId: undefined, teamId, attributedAt: split + 300, source: { kind: "booking_utm" } });
    await credit({ role: "dm_team", meetingId: meetingA, teamMemberId: undefined, teamId, attributedAt: from + 100, source: { kind: "booking_utm" } });
    await credit({ role: "closer", meetingId: meetingA, source: { kind: "booking_closer", userId: closerA } });
    await credit({ role: "closer", teamMemberId: memberB, meetingId: meetingB, source: { kind: "reassignment", userId: closerB }, attributedAt: split });
    // A credit after all payments still belongs in the chain, with zero cash.
    await credit({ role: "closer", teamMemberId: memberIdle, source: { kind: "booking_closer", userId: admin }, attributedAt: to });
    const pay = (fields: Partial<Doc<"paymentRecords">> = {}) => ctx.db.insert("paymentRecords", {
      tenantId, opportunityId: dealId, attributedCloserId: closerB, amountMinor: 10000, currency: "USD", recordedByUserId: admin,
      programId, programName: "Program", paymentType: "deposit", status: "recorded", recordedAt: from + 1000, origin: "admin_meeting", ...fields });
    await pay();
    await pay({ recordedAt: split + 1000, amountMinor: 20000, paymentType: "split" });
    await pay({ recordedAt: split + 2000, currency: "EUR", amountMinor: 7000, paymentType: "pif" });
    await pay({ recordedAt: from + 2000, status: "disputed", amountMinor: 999999 });
    for (const at of [from + 100, split + 100]) {
      await ctx.db.insert("slackQualificationEvents", { tenantId, installationId, leadId, opportunityId: dealId, slackUserId: "UA", slackTeamId: "T",
        qualifiedBy: { slackUserId: "UA", slackTeamId: "T", submittedAt: at }, fullNameSnapshot: "Person", resultKind: at < split ? "created_opportunity" : "duplicate_pending",
        platform: "instagram", handleSnapshot: "person", submittedAt: at, createdAt: at });
      await ctx.db.insert("leadGenSubmissions", { tenantId, prospectId, workerId: workerA, userId: closerA, teamId, source: "instagram",
        originKind: "follower", originRankable: false, submittedAt: at, createdAt: at });
    }
    await ctx.db.insert("leadGenSubmissions", { tenantId, prospectId, workerId: workerA, userId: closerA, source: "instagram",
      originKind: "follower", originRankable: false, submittedAt: from + 200, createdAt: from, voidedAt: split });
    for (const weekday of ["monday", "tuesday"] as const) {
      await ctx.db.insert("slackQualifierSchedules", { tenantId, slackUserId: "UA", weekday, scheduledHours: 8, updatedByUserId: admin, updatedAt: 0 });
      await ctx.db.insert("slackQualifierSchedules", { tenantId, slackUserId: "UA", weekday, effectiveFrom: "2026-09-29", scheduledHours: 6, updatedByUserId: admin, updatedAt: split });
      await ctx.db.insert("dmCloserSchedules", { tenantId, dmCloserId: dmA, weekday, scheduledHours: 5, updatedByUserId: admin, updatedAt: 0 });
      await ctx.db.insert("leadGenWorkerSchedules", { tenantId, workerId: workerA, userId: closerA, weekday, scheduledHours: 4, updatedByUserId: admin, updatedAt: 0 });
    }
    return { tenantId, memberA, memberB, memberIdle, dealId, meetingA, meetingB, moved, teamId, admin, closerA, closerB, workerA, workerB, prospectId };
  });
  return { t, ...fixture };
}

