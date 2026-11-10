import { convexTest } from "convex-test";
import type { Doc } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { convexTestModules } from "../convex/test.setup";
import { qualifiedLifecycle } from "./bookingHarness";
import { rowFromDoc } from "./analyticsParity";

export const DAY = 86_400_000;
export const from = Date.UTC(2026, 8, 1, 7);
export const split = from + 2 * DAY;
export const to = from + 4 * DAY;
export const now = to + DAY;
export const identity = { subject: "admin_b_reports", org_id: "org_b_reports" };
export const range = {
  startDate: "2026-09-01",
  endDateInclusive: "2026-09-04",
  fromMs: from,
  toMs: to,
  timeZone: "America/Tegucigalpa",
  dayStartHour: 1,
};
export const windows = {
  history: { startDate: from, endDate: split },
  today: { startDate: split, endDate: to },
  whole: { startDate: from, endDate: to },
};
export async function callsReportFixture() {
  const t = convexTest({ schema, modules: convexTestModules });
  const fixture = await t.run(async (ctx) => {
    const tenantId = await ctx.db.insert("tenants", {
      businessDayAppliedVersion: 0,
      companyName: "Reports",
      contactEmail: "reports@example.invalid",
      workosOrgId: identity.org_id,
      status: "active",
      inviteExpiresAt: now + DAY,
      createdBy: "test",
    });
    const member = (displayName: string) =>
      ctx.db.insert("teamMembers", {
        tenantId,
        displayName,
        createdAt: from,
        updatedAt: from,
      });
    const memberA = await member("Ana");
    const memberB = await member("Beto");
    const user = (
      workosUserId: string,
      role: Doc<"users">["role"],
      fullName: string,
      teamMemberId?: typeof memberA,
      isActive = true,
    ) =>
      ctx.db.insert("users", {
        tenantId,
        workosUserId,
        role,
        fullName,
        teamMemberId,
        isActive,
        email: `${workosUserId}@example.invalid`,
      });
    const admin = await user(identity.subject, "tenant_admin", "Admin");
    const ana = await user("reports_ana", "closer", "Ana", memberA);
    const beto = await user("reports_beto", "closer", "Beto", memberB);
    const inactive = await user(
      "reports_inactive",
      "closer",
      "Inactive",
      undefined,
      false,
    );
    const former = await user(
      "reports_former",
      "tenant_admin",
      "Former closer",
    );
    const programId = await ctx.db.insert("tenantPrograms", {
      tenantId,
      name: "Coaching",
      normalizedName: "coaching",
      createdAt: from,
      updatedAt: from,
      createdByUserId: admin,
    });
    const config = await ctx.db.insert("eventTypeConfigs", {
      tenantId,
      calendlyEventTypeUri: "test://type",
      displayName: "Standard",
      isExtended: true,
      createdAt: from,
      updatedAt: from,
    });
    const leadId = await ctx.db.insert("leads", {
      tenantId,
      ...qualifiedLifecycle(from),
      status: "active",
      firstSeenAt: from,
      updatedAt: from,
      fullName: "Person",
    });
    const deal = (outcome: Doc<"opportunities">["outcome"] = "open") =>
      ctx.db.insert("opportunities", {
        tenantId,
        leadId,
        stage: outcome === "open" ? "follow_up" : "closed",
        outcome,
        assignedCloserId: beto,
        eventTypeConfigId: config,
        createdAt: from - DAY,
        updatedAt: to,
      });
    const won = await deal("won");
    const old = await deal("won");
    const rebookDeal = await deal();
    const owedDeal = await deal();
    let serial = 0;
    const meeting = (
      opportunityId: typeof won,
      fields: Partial<Doc<"meetings">>,
    ) =>
      ctx.db.insert("meetings", {
        tenantId,
        opportunityId,
        assignedCloserId: beto,
        calendlyEventUri: `event${++serial}`,
        calendlyInviteeUri: `invitee${serial}`,
        scheduledAt: from + DAY,
        durationMinutes: 30,
        status: "scheduled",
        createdAt: from - 2 * DAY,
        leadName: "Person",
        bookingProgramId: programId,
        bookingProgramName: "Coaching",
        ...fields,
      });
    const hostChanged = await meeting(won, {
      status: "held",
      heldMarkedAt: from + DAY + 33 * 60_000,
    });
    const redistributed = await meeting(won, {
      scheduledAt: split + 3_600_000,
      status: "held",
      callClassification: "follow_up",
      heldMarkedAt: split + 95 * 60_000,
    });
    const preRange = await meeting(old, {
      scheduledAt: from - DAY,
      status: "held",
    });
    await meeting(old, {
      scheduledAt: split,
      status: "held",
      callClassification: "follow_up",
    });
    const noShow = await meeting(rebookDeal, {
      scheduledAt: from + 3_600_000,
      status: "no_show",
      noShowSource: "admin_manual",
      noShowReason: "no_response",
      noShowMarkedAt: from + 95 * 60_000,
    });
    const moved = await meeting(rebookDeal, {
      scheduledAt: from + 2 * 3_600_000,
      status: "canceled",
    });
    const rebooked = await meeting(rebookDeal, {
      scheduledAt: split + 2 * 3_600_000,
      status: "held",
      rescheduledFromMeetingId: noShow,
    });
    await meeting(rebookDeal, {
      scheduledAt: to + DAY,
      rescheduledFromMeetingId: moved,
    });
    const owed = await meeting(owedDeal, { scheduledAt: split + DAY });
    const canceled = await meeting(owedDeal, {
      scheduledAt: split + 4 * 3_600_000,
      status: "canceled",
    });
    const credit = (
      meetingId: typeof hostChanged,
      opportunityId: typeof won,
      userId: typeof ana,
      attributedAt: number,
      reassignment = false,
    ) =>
      ctx.db.insert("dealAttributions", {
        tenantId,
        meetingId,
        opportunityId,
        role: "closer",
        teamMemberId: userId === ana ? memberA : memberB,
        source: reassignment
          ? { kind: "reassignment", userId, fromUserId: ana }
          : { kind: "booking_closer", userId },
        attributedAt,
        createdAt: attributedAt,
      });
    await credit(hostChanged, won, ana, from);
    await credit(redistributed, won, ana, from);
    await credit(redistributed, won, beto, split, true);
    await credit(noShow, rebookDeal, ana, from);
    await credit(preRange, old, ana, from - DAY);
    await credit(rebooked, rebookDeal, former, split);
    const pay = (fields: Partial<Doc<"paymentRecords">>) =>
      ctx.db.insert("paymentRecords", {
        tenantId,
        opportunityId: won,
        meetingId: hostChanged,
        attributedCloserId: beto,
        amountMinor: 10_000,
        currency: "USD",
        recordedByUserId: admin,
        programId,
        programName: "Coaching",
        paymentType: "pif",
        status: "verified",
        origin: "closer_meeting",
        recordedAt: from + DAY,
        ...fields,
      });
    const firstPayment = await pay({
      paymentType: "deposit",
      amountMinor: 2_000,
    });
    await pay({
      recordedAt: split + DAY,
      currency: "HNL",
      amountMinor: 30_000,
    });
    await pay({ recordedAt: split + DAY, amountMinor: 4_000 });
    await pay({ status: "disputed", amountMinor: 999_999 });
    await pay({
      opportunityId: old,
      meetingId: preRange,
      recordedAt: from - DAY,
    });
    await pay({
      opportunityId: old,
      meetingId: undefined,
      recordedAt: split,
      attributedCloserId: ana,
    });
    await pay({
      opportunityId: undefined,
      meetingId: undefined,
      attributedCloserId: undefined,
      currency: "EUR",
      recordedAt: split,
    });
    return {
      tenantId,
      admin,
      ana,
      beto,
      inactive,
      former,
      memberA,
      memberB,
      programId,
      won,
      old,
      rebookDeal,
      owedDeal,
      hostChanged,
      redistributed,
      noShow,
      moved,
      rebooked,
      owed,
      canceled,
      firstPayment,
    };
  });
  const rows = await t.run(async (ctx) => {
    const meetings = (await ctx.db.query("meetings").take(100)).filter(
      (m) => m.scheduledAt >= from && m.scheduledAt < to,
    );
    const credits = await ctx.db.query("dealAttributions").take(100);
    const all = await ctx.db.query("meetings").take(100);
    const allPayments = await ctx.db.query("paymentRecords").take(100);
    const payments = allPayments.filter((p) => p.status !== "disputed");
    const deals = await ctx.db.query("opportunities").take(100);
    const configs = await ctx.db.query("eventTypeConfigs").take(100);
    const people = await ctx.db.query("leads").take(100);
    return {
      meetings: meetings
        .sort(
          (a, b) =>
            a.scheduledAt - b.scheduledAt || a._creationTime - b._creationTime,
        )
        .map((m) => {
          const credit = credits
            .filter((c) => c.meetingId === m._id && c.role === "closer")
            .sort((a, b) => b.attributedAt - a.attributedAt)[0];
          const deal = deals.find((d) => d._id === m.opportunityId);
          return {
            ...rowFromDoc("meetings", m),
            report_deal_outcome: deal?.outcome ?? null,
            report_event_type_config_id: deal?.eventTypeConfigId ?? null,
            report_is_extended: Number(
              configs.find((c) => c._id === deal?.eventTypeConfigId)
                ?.isExtended ?? false,
            ),
            report_lead_name:
              m.leadName ??
              people.find((p) => p._id === deal?.leadId)?.fullName ??
              "Unknown person",
            report_closer_id:
              credit && "userId" in credit.source
                ? credit.source.userId
                : m.assignedCloserId,
            report_moved: Number(
              m.status === "canceled" &&
                all.some((s) => s.rescheduledFromMeetingId === m._id),
            ),
            report_rebooked: Number(
              all.some(
                (p) =>
                  p._id === m.rescheduledFromMeetingId &&
                  p.status === "no_show",
              ),
            ),
          };
        }),
      payments: payments
        .filter((p) => p.recordedAt >= from && p.recordedAt < to)
        .map((p) => rowFromDoc("paymentRecords", p)),
      callPayments: payments
        .filter((p) => meetings.some((m) => m._id === p.meetingId))
        .map((p) => rowFromDoc("paymentRecords", p)),
      cohort: deals.flatMap((d) => {
        const first = all
          .filter((m) => m.opportunityId === d._id && m.status === "held")
          .sort((a, b) => a.scheduledAt - b.scheduledAt)[0];
        return first && first.scheduledAt >= from && first.scheduledAt < to
          ? [{ meeting_id: first._id, outcome: d.outcome }]
          : [];
      }),
      firstPayments: deals.flatMap((d) => {
        const first = payments
          .filter((p) => p.opportunityId === d._id)
          .sort((a, b) => a.recordedAt - b.recordedAt)[0];
        return first && first.recordedAt >= from && first.recordedAt < to
          ? [{ payment_id: first._id }]
          : [];
      }),
      firstPaymentDeals: deals.flatMap((d) => {
        const dealPayments = payments.filter((p) => p.opportunityId === d._id);
        const first = [...dealPayments].sort((a, b) => a.recordedAt - b.recordedAt)[0];
        // Participation counts disputed payments too, as the SQL and live reader do.
        const history = allPayments.filter((p) => p.opportunityId === d._id);
        return first && first.recordedAt >= from && first.recordedAt < to
          ? [{
              opportunity_id: d._id,
              closer_ids: [...new Set(history.flatMap((p) => (p.attributedCloserId ? [p.attributedCloserId] : [])))],
            }]
          : [];
      }),
    };
  });
  return { t, ...fixture, rows };
}

/** A month larger than the live dimension caps, with warehouse snapshots. */
export async function warehouseMonthFixture() {
  const fixture = await callsReportFixture();
  const rows = await fixture.t.run(async (ctx) => {
    const baseMeeting = (await ctx.db.get("meetings", fixture.hostChanged))!;
    const baseDeal = (await ctx.db.get("opportunities", fixture.won))!;
    const { _id: dealId, _creationTime: dealCreated, ...deal } = baseDeal;
    const {
      _id: meetingId,
      _creationTime: meetingCreated,
      ...meeting
    } = baseMeeting;
    void dealId;
    void dealCreated;
    void meetingId;
    void meetingCreated;
    const rows = [];
    for (let index = 0; index < 1001; index++) {
      const opportunityId = await ctx.db.insert("opportunities", {
        ...deal,
        outcome: "open",
        stage: "booked",
      });
      const id = await ctx.db.insert("meetings", {
        ...meeting,
        opportunityId,
        scheduledAt: from + DAY + index * 60_000,
        leadName: undefined,
      });
      const doc = (await ctx.db.get("meetings", id))!;
      rows.push({
        ...rowFromDoc("meetings", doc),
        id: doc._id,
        report_closer_id: fixture.ana,
        report_moved: 0,
        report_rebooked: 0,
        report_deal_outcome: index % 2 ? "lost" : "won",
        report_event_type_config_id: deal.eventTypeConfigId,
        report_is_extended: index % 2 ? 0 : 1,
        report_lead_name: `Warehouse person ${index}`,
      });
    }
    return rows;
  });
  return { ...fixture, warehouseRows: rows };
}
