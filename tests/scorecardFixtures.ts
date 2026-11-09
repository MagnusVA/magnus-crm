import { convexTest } from "convex-test";
import aggregate from "@convex-dev/aggregate/test";
import schema from "../convex/schema";
import { convexTestModules } from "../convex/test.setup";
import type { Doc } from "../convex/_generated/dataModel";
import { syncLeadStageEntries } from "../convex/lib/leadLifecycle";
import { resolveAnalyticsRange } from "../lib/analyticsRange";

export const identity = { subject: "score_admin", org_id: "org_score" };
export const setting = { timeZone: "America/Tegucigalpa", dayStartHour: 1 };
export const whole = resolveAnalyticsRange({ kind: "custom", startDate: "2026-10-30", endDateInclusive: "2026-10-31" }, setting, 0);
export const history = resolveAnalyticsRange({ kind: "custom", startDate: "2026-10-30", endDateInclusive: "2026-10-30" }, setting, 0);
export const today = resolveAnalyticsRange({ kind: "custom", startDate: "2026-10-31", endDateInclusive: "2026-10-31" }, setting, 0);
export const HOUR = 3_600_000;
export async function scorecardFixture() {
  const t = convexTest({ schema, modules: convexTestModules, transactionLimits: true });
  aggregate.register(t, "leadStageEntries");
  const fixture = await t.run(async ctx => {
    const tenantId = await ctx.db.insert("tenants", { businessDay: setting, businessDayAppliedVersion: 0, companyName: "Score",
      contactEmail: "score@example.invalid", workosOrgId: identity.org_id, status: "active", inviteExpiresAt: 0, createdBy: "test" });
    const memberId = await ctx.db.insert("teamMembers", { tenantId, displayName: "Credited closer", createdAt: 0, updatedAt: 0 });
    const adminId = await ctx.db.insert("users", { tenantId, workosUserId: identity.subject, email: "admin@example.invalid", role: "tenant_admin", fullName: "Admin", isActive: true });
    const closerId = await ctx.db.insert("users", { tenantId, workosUserId: "score_closer", email: "closer@example.invalid", role: "closer", fullName: "Assigned closer", teamMemberId: memberId, isActive: true });
    const programId = await ctx.db.insert("tenantPrograms", { tenantId, name: "Program", normalizedName: "program", createdAt: 0, updatedAt: 0, createdByUserId: adminId });
    const person = async (name: string, times: Doc<"leads">["lifecycleStageEnteredAt"], status: Doc<"leads">["status"] = "active") => {
      const stage = times.customer !== undefined ? "customer" : times.showed !== undefined ? "showed" : "qualified";
      const id = await ctx.db.insert("leads", { tenantId, fullName: name, firstSeenAt: whole.fromMs, updatedAt: whole.fromMs,
        status, lifecycleStage: stage, lifecycleStageEnteredAt: times, disposition: "open" });
      if (status !== "merged") await syncLeadStageEntries(ctx, tenantId, id, null, { stage, enteredAt: times });
      return id;
    };
    const at = whole.fromMs + HOUR;
    const later = today.fromMs + HOUR;
    const leadA = await person("=Formula person", { prospect: at, in_conversation: at, qualified: at, booked: at, showed: later, customer: later });
    const leadB = await person("Person B", { prospect: at - 5 * 86400000, in_conversation: at - 5 * 86400000, qualified: later, booked: later, showed: later, customer: later });
    const leadC = await person("Person C", { prospect: later, in_conversation: later, qualified: later });
    await person("Merged", { prospect: later, in_conversation: later, qualified: later }, "merged");
    const deal = (leadId: typeof leadA, fields: Partial<Doc<"opportunities">>) => ctx.db.insert("opportunities", {
      tenantId, leadId, stage: "closed", outcome: "won", createdAt: at, updatedAt: at, firstBookingProgramId: programId,
      assignedCloserId: closerId, ...fields,
    });
    const touchId = await ctx.db.insert("domainEvents", { tenantId, entityType: "lead", entityId: leadA, leadId: leadA, eventType: "lead.captured", source: "system", occurredAt: at });
    const dealA = await deal(leadA, { paymentReceivedAt: at, firstTouch: { channel: "lead_gen", eventId: touchId, eventType: "lead.captured", occurredAt: at } });
    const dealB = await deal(leadB, { paymentReceivedAt: later });
    const dealC = await deal(leadC, { outcome: "lost", lostAt: later, paymentReceivedAt: at });
    const pay = (fields: Partial<Doc<"paymentRecords">>) => ctx.db.insert("paymentRecords", { tenantId, opportunityId: dealA,
      attributedCloserId: closerId, amountMinor: 10000, currency: "USD", recordedByUserId: adminId, programId, programName: "Program",
      paymentType: "deposit", status: "verified", recordedAt: at, origin: "closer_meeting", ...fields });
    const depositId = await pay({});
    await pay({ amountMinor: 90000, paymentType: "split", recordedAt: later });
    await pay({ opportunityId: dealB, currency: "EUR", amountMinor: 25000, paymentType: "pif", recordedAt: later });
    await pay({ opportunityId: dealC, amountMinor: 2000 });
    await pay({ status: "disputed", amountMinor: 99999, recordedAt: later });
    const meeting = (fields: Partial<Doc<"meetings">>) => ctx.db.insert("meetings", { tenantId, opportunityId: dealA, assignedCloserId: closerId,
      calendlyEventUri: "event", calendlyInviteeUri: "invitee", scheduledAt: later, durationMinutes: 30, status: "held", createdAt: at,
      bookingProgramId: programId, bookingProgramName: "Program", callClassification: "new", ...fields });
    const meetingA = await meeting({});
    const replacement = await meeting({ createdAt: later, status: "canceled", rescheduledFromMeetingId: meetingA });
    const meetingB = await meeting({ createdAt: later, opportunityId: dealB });
    const moved = await meeting({ createdAt: at, status: "canceled", scheduledAt: at });
    await meeting({ createdAt: later, scheduledAt: later + HOUR, rescheduledFromMeetingId: moved, status: "scheduled" });
    const source = { kind: "booking_closer" as const, userId: closerId };
    await ctx.db.insert("dealAttributions", { tenantId, opportunityId: dealA, role: "closer", teamMemberId: memberId, source,
      meetingId: meetingA, meetingScheduledAt: later, attributedAt: at - HOUR, createdAt: at - HOUR });
    await ctx.db.insert("dealAttributions", { tenantId, opportunityId: dealA, role: "closer", teamMemberId: memberId,
      source: { kind: "reassignment", userId: closerId }, meetingId: meetingA, attributedAt: later, createdAt: later });
    const lateMemberId = await ctx.db.insert("teamMembers", { tenantId, displayName: "Later credit", createdAt: 0, updatedAt: 0 });
    await ctx.db.insert("dealAttributions", { tenantId, opportunityId: dealA, role: "closer", teamMemberId: lateMemberId,
      source: { kind: "reassignment", userId: closerId }, meetingId: replacement, attributedAt: later + HOUR, createdAt: later + HOUR });
    const reminder = (fields: Partial<Doc<"followUps">>) => ctx.db.insert("followUps", { tenantId, opportunityId: dealA, leadId: leadA,
      closerId, type: "manual_reminder", reminderScheduledAt: at, reason: "closer_initiated", status: "completed", createdAt: at, ...fields });
    await reminder({ completedAt: history.toMs - 1 });
    await reminder({ completedAt: history.toMs });
    await reminder({ status: "pending", reminderScheduledAt: later });
    await reminder({ type: "scheduling_link", status: "pending" });
    const configId = await ctx.db.insert("eventTypeConfigs", { tenantId, calendlyEventTypeUri: "type", displayName: "Sales", createdAt: at, customFieldMappings: { phoneField: "Phone" } });
    const catalogId = await ctx.db.insert("eventTypeFieldCatalog", { tenantId, eventTypeConfigId: configId, fieldKey: "budget", currentLabel: "Budget", firstSeenAt: at, lastSeenAt: later });
    for (const [meetingId, leadId, opportunityId, capturedAt, answerText] of [
      [meetingA, leadA, dealA, at, "  High  "], [replacement, leadA, dealA, later, "High"], [meetingB, leadB, dealB, later, "Low"],
    ] as const) await ctx.db.insert("meetingFormResponses", { tenantId, eventTypeConfigId: configId, fieldCatalogId: catalogId,
      meetingId, leadId, opportunityId, capturedAt, fieldKey: "budget", questionLabelSnapshot: "Budget", answerText });
    return { tenantId, adminId, closerId, memberId, programId, leadA, leadB, leadC, dealA, dealB, dealC, depositId, meetingA, replacement };
  });
  const docs = await t.run(async ctx => ({
    payments: await ctx.db.query("paymentRecords").take(100), deals: await ctx.db.query("opportunities").take(100),
    meetings: await ctx.db.query("meetings").take(100), people: await ctx.db.query("leads").take(100),
    reminders: await ctx.db.query("followUps").take(100), users: await ctx.db.query("users").take(100), responses: await ctx.db.query("meetingFormResponses").take(100),
  }));
  return { t, ...fixture, ...docs };
}
