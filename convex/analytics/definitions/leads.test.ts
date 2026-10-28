import { describe, expect, it } from "vitest";
import { bookingHarness } from "../../../tests/bookingHarness";
import { expectSameAnswer } from "../../../tests/analyticsParity";
import {
  DAY,
  fixtureUsers,
  insertDeal,
  insertEnrollment,
  insertMeeting,
  insertPayment,
  insertPerson,
  insertProgram,
  seedCustomer,
} from "../../../tests/enrollmentReadFixtures";
import { api } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { readLifecycle, syncLeadStageEntries } from "../../lib/leadLifecycle";

const identity = { subject: "user_admin", org_id: "org_test" };
const range = {
  startDate: "2026-05-01",
  endDateInclusive: "2026-05-31",
  fromMs: Date.parse("2026-05-01T06:00:00Z"),
  toMs: Date.parse("2026-06-01T06:00:00Z"),
  timeZone: "America/Tegucigalpa",
  dayStartHour: 0,
};
const window = { startDate: range.fromMs, endDate: range.toMs };
const inRange = (at: number) => at >= range.fromMs && at < range.toMs;
const AT = Date.parse("2026-05-10T12:00:00Z");

async function createFixture() {
  const harness = await bookingHarness();
  const { t, tenantId } = harness;
  await t.run(async (ctx) => {
    const { admin, closer } = await fixtureUsers(ctx, tenantId);
    await ctx.db.patch("users", closer._id, { fullName: "Carla Closer" });
    const program = await insertProgram(ctx, tenantId, admin._id, "Program");
    const second = await insertProgram(ctx, tenantId, admin._id, "Second");

    // Converts in May; buys a second program later in May, which isn't a
    // conversion.
    const repeat = await seedCustomer(ctx, tenantId, { closerId: closer._id, programId: program, paidAt: AT });
    const secondDeal = await insertDeal(ctx, { tenantId, leadId: repeat.leadId, assignedCloserId: closer._id });
    await insertPayment(ctx, { tenantId, opportunityId: secondDeal, programId: second, recordedByUserId: closer._id, recordedAt: AT + 5 * DAY });
    await insertEnrollment(ctx, { tenantId, leadId: repeat.leadId, programId: second, opportunityId: secondDeal, enrolledAt: AT + 5 * DAY });
    // Two meetings on the winning deal.
    await insertMeeting(ctx, { tenantId, opportunityId: repeat.opportunityId, closerId: closer._id, scheduledAt: AT - 2 * DAY });

    // A deal with no closer falls back to the recorder, an admin: excluded.
    await seedCustomer(ctx, tenantId, {
      closerId: closer._id, recorderId: admin._id, programId: program, paidAt: AT + DAY, assignedCloserId: null, withMeeting: false,
    });
    // First seen after converting: no time-to-conversion sample.
    const late = await seedCustomer(ctx, tenantId, { closerId: closer._id, programId: second, paidAt: AT + 2 * DAY });
    await ctx.db.patch("leads", late.leadId, { firstSeenAt: AT + 3 * DAY });
    // Converted in April; their May enrollment isn't their first.
    const april = await seedCustomer(ctx, tenantId, { closerId: closer._id, programId: program, paidAt: AT - 20 * DAY });
    const aprilDeal = await insertDeal(ctx, { tenantId, leadId: april.leadId, assignedCloserId: closer._id });
    await insertPayment(ctx, { tenantId, opportunityId: aprilDeal, programId: second, recordedByUserId: closer._id, recordedAt: AT + 4 * DAY });
    await insertEnrollment(ctx, { tenantId, leadId: april.leadId, programId: second, opportunityId: aprilDeal, enrolledAt: AT + 4 * DAY });
    // Converted in June.
    await seedCustomer(ctx, tenantId, { closerId: closer._id, programId: program, paidAt: range.toMs + DAY });

    // New leads: qualified in May, before it, and a merged person.
    await insertPerson(ctx, tenantId, { firstSeenAt: AT });
    await insertPerson(ctx, tenantId, { firstSeenAt: range.fromMs });
    await insertPerson(ctx, tenantId, { firstSeenAt: range.fromMs - 1 });
    await insertPerson(ctx, tenantId, { firstSeenAt: AT, status: "merged" });
    for (const lead of await ctx.db.query("leads").take(100)) {
      if (lead.status !== "merged") await syncLeadStageEntries(ctx, tenantId, lead._id, null, readLifecycle(lead));
    }

    // Form answers on May's meetings, with a tie, padded answers and an
    // empty one.
    const meetings = (await ctx.db.query("meetings").take(100)).filter((meeting) => inRange(meeting.scheduledAt));
    const answer = (meeting: Doc<"meetings">, fieldKey: string, answerText: string, capturedAt = meeting.scheduledAt) =>
      ctx.db.insert("meetingFormResponses", {
        tenantId, meetingId: meeting._id, opportunityId: meeting.opportunityId, leadId: repeat.leadId,
        fieldKey, questionLabelSnapshot: fieldKey, answerText, capturedAt,
      });
    await answer(meetings[0], "budget", "Yes");
    await answer(meetings[0], "handle", "@ana");
    await answer(meetings[1], "budget", " Yes ");
    await answer(meetings[1], "handle", "@beto");
    await answer(meetings[1], "notes", "   ");
    await answer(meetings[2], "budget", "No");
    await answer(meetings[2], "handle", "@Carla", range.toMs + DAY);
  });
  return harness;
}

// What the conversion SQL returns for these documents.
async function conversionRows(ctx: MutationCtx) {
  const enrollments = await ctx.db.query("enrollments").take(100);
  const first = new Map<Id<"leads">, Doc<"enrollments">>();
  for (const enrollment of [...enrollments].sort((a, b) => a.enrolledAt - b.enrolledAt || a._creationTime - b._creationTime)) {
    if (!first.has(enrollment.leadId)) first.set(enrollment.leadId, enrollment);
  }
  const payments = await ctx.db.query("paymentRecords").take(100);
  const meetings = await ctx.db.query("meetings").take(100);
  const conversions = [];
  for (const enrollment of [...first.values()].filter((row) => inRange(row.enrolledAt))) {
    const payment = payments
      .filter((row) => row.opportunityId === enrollment.opportunityId && row.programId === enrollment.programId && row.recordedAt === enrollment.enrolledAt && row.status !== "disputed")
      .sort((a, b) => a._creationTime - b._creationTime)[0];
    const deal = await ctx.db.get("opportunities", enrollment.opportunityId);
    const lead = await ctx.db.get("leads", enrollment.leadId);
    conversions.push({
      lead_id: enrollment.leadId,
      converted_at_ms: enrollment.enrolledAt,
      winning_opportunity_id: enrollment.opportunityId,
      converted_by_user_id: payment?.recordedByUserId ?? null,
      deal_found: deal ? 1 : 0,
      deal_closer_id: deal?.assignedCloserId ?? null,
      lead_found: lead ? 1 : 0,
      lead_first_seen_at_ms: lead?.firstSeenAt ?? null,
      meeting_count: meetings.filter((meeting) => meeting.opportunityId === enrollment.opportunityId).length,
    });
  }
  const leads = await ctx.db.query("leads").take(100);
  const newLeads = leads.filter((lead) => lead.status !== "merged" && inRange(lead.lifecycleStageEnteredAt.qualified ?? -1)).length;
  return { new_leads: [{ count: newLeads }], conversions };
}

// What the form SQL returns: answers trimmed and counted per field.
async function formRows(ctx: MutationCtx) {
  const meetingIds = new Set((await ctx.db.query("meetings").take(100)).filter((meeting) => inRange(meeting.scheduledAt)).map((meeting) => meeting._id));
  const responses = (await ctx.db.query("meetingFormResponses").take(100)).filter((row) => meetingIds.has(row.meetingId));
  const counts = new Map<string, Map<string, number>>();
  for (const row of responses) {
    const answer = row.answerText.trim();
    if (answer === "") continue;
    const field = counts.get(row.fieldKey) ?? new Map<string, number>();
    field.set(answer, (field.get(answer) ?? 0) + 1);
    counts.set(row.fieldKey, field);
  }
  const top_answers = [...counts].flatMap(([field_key, answers]) => {
    const top = Math.max(...answers.values());
    const total = [...answers.values()].reduce((sum, count) => sum + count, 0);
    return [...answers]
      .filter(([, count]) => count === top)
      .map(([answer, count]) => ({ field_key, answer, count, total_responses: total }));
  });
  return {
    meetings: [{ total_meetings: meetingIds.size, responded_meetings: new Set(responses.map((row) => row.meetingId)).size }],
    top_answers,
  };
}

async function distributionRows(ctx: MutationCtx, fieldKey: string) {
  const responses = (await ctx.db.query("meetingFormResponses").take(100))
    .filter((row) => row.fieldKey === fieldKey && inRange(row.capturedAt));
  const counts = new Map<string, { count: number; first: number }>();
  for (const row of responses) {
    const answer = row.answerText.trim();
    if (answer === "") continue;
    const entry = counts.get(answer) ?? { count: 0, first: row._creationTime };
    entry.count += 1;
    counts.set(answer, entry);
  }
  return {
    answers: [...counts]
      .sort(([, a], [, b]) => b.count - a.count || a.first - b.first)
      .map(([answer, { count }]) => ({ answer, count })),
  };
}

describe("Leads & Conversions from ClickHouse rows", () => {
  it("matches the conversion metrics", async () => {
    const { t, tenantId } = await createFixture();
    const live = await expectSameAnswer({
      t, identity, tenantId, range,
      rows: await t.run(conversionRows),
      reportId: "leads.conversion_metrics",
      live: api.reporting.leadConversion.getLeadConversionMetrics,
      liveArgs: window,
      filters: {},
    });
    expect(live).toMatchObject({
      newLeads: 6,
      totalConversions: 2,
      excludedConversions: 1,
      meetingsPerSaleNumerator: 3,
      timeToConversionSampleCount: 2,
    });
  });

  it("matches the form response KPIs and answer distributions", async () => {
    const { t, tenantId } = await createFixture();
    const base = { t, identity, tenantId, range };
    const kpis = await expectSameAnswer({
      ...base,
      rows: await t.run(formRows),
      reportId: "leads.form_kpis",
      live: api.reporting.formResponseAnalytics.getFormResponseKpis,
      liveArgs: window,
      filters: {},
    });
    expect(kpis.topAnswerPerField).toHaveLength(2);
    for (const fieldKey of ["budget", "handle"]) {
      const distribution = await expectSameAnswer({
        ...base,
        rows: await t.run((ctx) => distributionRows(ctx, fieldKey)),
        reportId: "leads.answer_distribution",
        live: api.reporting.formResponseAnalytics.getAnswerDistribution,
        liveArgs: { ...window, fieldKey },
        filters: { fieldKey },
      });
      expect(distribution.totalResponses).toBe(fieldKey === "budget" ? 3 : 2);
    }
  });
});
