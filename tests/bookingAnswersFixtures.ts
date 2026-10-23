import type { Id } from "../convex/_generated/dataModel";
import type { MutationCtx } from "../convex/_generated/server";
import { insertPerson, insertPersonDeal } from "./stageLabelFixtures";
import { insertLatestMeeting } from "./dealStageFixtures";

export async function seedBookingAnswers(ctx: MutationCtx, tenantId: Id<"tenants">) {
  const leadId = await insertPerson(ctx, tenantId);
  await ctx.db.patch("leads", leadId, {
    customFields: { goal: "Latest person answer" },
    customFieldLabels: { goal: "Latest person question" },
  });
  const opportunityId = await insertPersonDeal(ctx, { tenantId, leadId, status: "scheduled" });
  const first = await insertLatestMeeting(ctx, opportunityId, { status: "scheduled", scheduledAt: 2_000 });
  const second = await insertLatestMeeting(ctx, opportunityId, { status: "scheduled", scheduledAt: 3_000 });
  const empty = await insertLatestMeeting(ctx, opportunityId, { status: "scheduled", scheduledAt: 4_000 });
  const base = { tenantId, opportunityId, leadId };
  await ctx.db.insert("meetingFormResponses", {
    ...base, meetingId: first, fieldKey: "goal", questionLabelSnapshot: "Original goal?",
    answerText: "First booking goal", capturedAt: 200,
  });
  await ctx.db.insert("meetingFormResponses", {
    ...base, meetingId: first, fieldKey: "budget", questionLabelSnapshot: "Budget?",
    answerText: "100", capturedAt: 100,
  });
  await ctx.db.insert("meetingFormResponses", {
    ...base, meetingId: first, fieldKey: "availability", questionLabelSnapshot: "When?",
    answerText: "Monday", capturedAt: 100,
  });
  await ctx.db.insert("meetingFormResponses", {
    ...base, meetingId: second, fieldKey: "goal", questionLabelSnapshot: "New goal?",
    answerText: "Second booking goal", capturedAt: 300,
  });
  const otherTenantId = await ctx.db.insert("tenants", {
    companyName: "Other", contactEmail: "other@example.com", workosOrgId: "org_other",
    status: "active", inviteExpiresAt: 0, createdBy: "test",
  });
  await ctx.db.insert("meetingFormResponses", {
    ...base, tenantId: otherTenantId, meetingId: first, fieldKey: "private",
    questionLabelSnapshot: "Other tenant question", answerText: "Other tenant answer", capturedAt: 50,
  });
  return { first, second, empty };
}
