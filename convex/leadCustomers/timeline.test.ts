/**
 * One timeline per person, from the event log, and a Slack touch for every
 * qualification (docs/plans/phase-2-person-first.md §5, §6.1).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { bookingHarness } from "../../tests/bookingHarness";
import { seedEnrolledCustomer } from "../../tests/enrollmentPageFixtures";
import {
  insertDealEvent,
  insertPerson,
  insertPersonDeal,
  insertReminder,
  insertSideDealPayment,
} from "../../tests/stageLabelFixtures";

afterEach(() => vi.useRealTimers());

type Harness = Awaited<ReturnType<typeof setup>>;

const NOW = Date.parse("2026-10-10T12:00:00Z");

async function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  const harness = await bookingHarness();
  const installationId = await harness.t.run(async (ctx) =>
    await ctx.db.insert("slackInstallations", {
      tenantId: harness.tenantId, teamId: "T1", teamName: "Team", isEnterpriseInstall: false,
      appId: "A1", botUserId: "B1", botAccessToken: "xoxb", scopes: [], notifyChannelId: "C1",
      notifyChannelName: "qualified", installedByWorkosUserId: "user_slack", installedAt: 0,
      tokenExpiresAt: 0, refreshToken: "r", status: "active",
    }),
  );
  return { ...harness, installationId };
}

async function qualify(h: Harness, handle: string, submittedAt: number) {
  await h.t.mutation(internal.slack.createQualifiedLead.create, {
    tenantId: h.tenantId,
    installationId: h.installationId,
    fullName: "Ana Lead",
    handle,
    country: "Honduras",
    leadType: "pt",
    qualifiedBy: { slackUserId: "U1", slackTeamId: "T1", submittedAt },
  });
  await h.t.finishAllScheduledFunctions(vi.runAllTimers);
}

async function timeline(h: Harness, leadId: string) {
  const result = await h.admin.query(api.leadCustomers.timeline.getLeadTimeline, {
    leadId: leadId as never,
  });
  return result!.entries;
}

describe("person timeline", () => {
  it("shows the capture, the qualification and the stage change, newest first, with who acted", async () => {
    const h = await setup();
    const { leadId } = await h.admin.mutation(api.leadGen.capture.submit, {
      source: "instagram", rawHandleOrProfileUrl: "@ana.lead", originKind: "follower",
    });
    vi.setSystemTime(new Date(NOW + 60_000));
    await qualify(h, "ana.lead", NOW + 60_000);

    const entries = await timeline(h, leadId!);

    const types = entries.map((entry) => entry.eventType);
    expect(types).toContain("lead.captured");
    expect(types).toContain("lead.slack_qualified");
    expect(types).toContain("lead.lifecycle_stage_changed");
    expect(entries.map((entry) => entry.occurredAt)).toEqual(
      [...entries.map((entry) => entry.occurredAt)].sort((a, b) => b - a),
    );
    const capture = entries.find((entry) => entry.eventType === "lead.captured");
    expect(capture).toMatchObject({ label: "Captured by lead gen", detail: "instagram · follower" });
    expect(capture?.actorName).toBe("admin@example.com");
    const stage = entries.find((entry) => entry.eventType === "lead.lifecycle_stage_changed");
    expect(stage).toMatchObject({ fromStatus: "In conversation", toStatus: "Qualified" });
  });

  it("includes the events of a lead merged into the person", async () => {
    const h = await setup();
    await qualify(h, "ana.lead", NOW - 1_000);
    await qualify(h, "ana.other", NOW - 500);
    const [target, source] = await h.t.run(async (ctx) => {
      const leads = await ctx.db.query("leads").take(2);
      return leads.map((lead) => lead._id);
    });

    await h.admin.mutation(api.leads.merge.mergeLead, { sourceLeadId: source, targetLeadId: target });
    await h.t.finishAllScheduledFunctions(vi.runAllTimers);

    const touches = (await timeline(h, target)).filter((entry) => entry.eventType === "lead.slack_qualified");
    expect(touches).toHaveLength(2);
  });
});

describe("person timeline across merges and limits", () => {
  it("includes events of a lead merged into one that was merged in later", async () => {
    const h = await setup();
    await qualify(h, "ana.first", NOW - 3_000);
    await qualify(h, "ana.second", NOW - 2_000);
    await qualify(h, "ana.third", NOW - 1_000);
    const [first, second, third] = await h.t.run(async (ctx) =>
      (await ctx.db.query("leads").take(3)).map((lead) => lead._id),
    );

    await h.admin.mutation(api.leads.merge.mergeLead, { sourceLeadId: first, targetLeadId: second });
    await h.admin.mutation(api.leads.merge.mergeLead, { sourceLeadId: second, targetLeadId: third });
    await h.t.finishAllScheduledFunctions(vi.runAllTimers);

    const touches = (await timeline(h, third)).filter((entry) => entry.eventType === "lead.slack_qualified");
    expect(touches).toHaveLength(3);
  });

  it("stops offering older events at the largest page, and says so", async () => {
    const h = await setup();
    await qualify(h, "ana.lead", NOW - 1_000);
    const leadId = await h.t.run(async (ctx) => {
      const lead = (await ctx.db.query("leads").first())!;
      for (let i = 0; i < 1_005; i++) {
        await ctx.db.insert("domainEvents", {
          tenantId: h.tenantId, entityType: "lead", entityId: lead._id, eventType: "lead.portal_note_added",
          occurredAt: NOW - 100_000 - i, source: "pipeline", leadId: lead._id,
        });
      }
      return lead._id;
    });

    const page = await h.admin.query(api.leadCustomers.timeline.getLeadTimeline, { leadId, limit: 100 });
    const largest = await h.admin.query(api.leadCustomers.timeline.getLeadTimeline, { leadId, limit: 5_000 });

    expect(page).toMatchObject({ hasMore: true, capped: false, limit: 100 });
    expect(largest).toMatchObject({ hasMore: false, capped: true, limit: 1_000 });
  });
});

describe("enrollment events", () => {
  it("shows a program's status change with its program and reason", async () => {
    const h = await setup();
    const seeded = await h.t.run((ctx) => seedEnrolledCustomer(ctx, h.tenantId));
    await h.admin.mutation(api.enrollments.mutations.updateEnrollmentStatus, {
      enrollmentId: seeded.enrollmentA,
      status: "paused",
      expectedStatus: "active",
      reason: "Moving abroad",
    });

    const entries = await timeline(h, seeded.leadId);

    expect(entries.find((entry) => entry.eventType === "enrollment.status_changed")).toMatchObject({
      label: "Program status changed",
      fromStatus: "Active",
      toStatus: "Paused",
      detail: "Program A · Moving abroad",
      actorName: "admin@example.com",
    });
  });
});

describe("Slack touches", () => {
  it("records a touch for every qualification, including one that joins an open deal", async () => {
    const h = await setup();
    await qualify(h, "ana.lead", NOW - 1_000);
    await qualify(h, "ana.lead", NOW - 500);

    const touches = await h.t.run(async (ctx) =>
      (await ctx.db.query("domainEvents").take(100)).filter((event) => event.eventType === "lead.slack_qualified"),
    );
    expect(touches).toHaveLength(2);
  });
});

// Old deal events hold statuses; from PR 8 they hold stages, with the
// outcomes in the metadata (docs/plans/phase-5-deal-status.md §4.7).
describe("deal events", () => {
  it("labels old deal events by status and new ones by stage", async () => {
    const h = await bookingHarness();
    const leadId = await h.t.run(async (ctx) => {
      const leadId = await insertPerson(ctx, h.tenantId);
      const opportunityId = await insertPersonDeal(ctx, { tenantId: h.tenantId, leadId, status: "lost" });
      await insertDealEvent(ctx, opportunityId, {
        eventType: "opportunity.status_changed", occurredAt: 1_000,
        fromStatus: "qualified_pending", toStatus: "scheduled",
      });
      await insertDealEvent(ctx, opportunityId, {
        eventType: "opportunity.stage_changed", occurredAt: 2_000,
        fromStatus: "booked", toStatus: "follow_up", metadata: { fromOutcome: "open", toOutcome: "open" },
      });
      await insertDealEvent(ctx, opportunityId, {
        eventType: "opportunity.marked_lost", occurredAt: 3_000,
        fromStatus: "follow_up", toStatus: "closed", reason: "Price",
        metadata: { fromOutcome: "open", toOutcome: "lost" },
      });
      return leadId;
    });
    const timeline = await h.admin.query(api.leadCustomers.timeline.getLeadTimeline, { leadId });
    expect(timeline?.entries.map(({ label, fromStatus, toStatus }) => ({ label, fromStatus, toStatus }))).toEqual([
      { label: "Deal marked lost", fromStatus: "Follow-up", toStatus: "Closed (lost)" },
      { label: "Deal stage changed", fromStatus: "Booked", toStatus: "Follow-up" },
      { label: "Deal stage changed", fromStatus: "Qualified, not booked", toStatus: "Scheduled" },
    ]);
  });
});

// The page writes each event as "fact · deal" (the person page's timeline).
describe("event subjects", () => {
  it("names each event's deal, a payment's amount and a task's kind", async () => {
    const h = await bookingHarness();
    const ids = await h.t.run(async (ctx) => {
      const leadId = await insertPerson(ctx, h.tenantId);
      const opportunityId = await insertPersonDeal(ctx, { tenantId: h.tenantId, leadId, status: "follow_up_scheduled" });
      const followUpId = await insertReminder(ctx, opportunityId);
      const paymentId = await insertSideDealPayment(ctx, opportunityId);
      const payment = (await ctx.db.get("paymentRecords", paymentId))!;
      const base = { tenantId: h.tenantId, leadId, source: "closer" as const };
      await insertDealEvent(ctx, opportunityId, { eventType: "opportunity.created", occurredAt: 1_000 });
      await ctx.db.insert("domainEvents", {
        ...base, entityType: "followUp", entityId: followUpId, eventType: "followUp.created", occurredAt: 2_000,
      });
      await ctx.db.insert("domainEvents", {
        ...base, entityType: "payment", entityId: paymentId, eventType: "payment.recorded", occurredAt: 3_000,
      });
      return { leadId, opportunityId, payment };
    });

    const entries =
      (await h.admin.query(api.leadCustomers.timeline.getLeadTimeline, { leadId: ids.leadId }))?.entries ?? [];
    const byType = new Map(entries.map((entry) => [entry.eventType, entry]));

    expect(byType.get("opportunity.created")).toMatchObject({ opportunityId: ids.opportunityId, amount: null, task: null });
    expect(byType.get("followUp.created")).toMatchObject({
      opportunityId: ids.opportunityId,
      task: { type: "manual_reminder", reschedule: false },
    });
    expect(byType.get("payment.recorded")).toMatchObject({
      opportunityId: ids.opportunityId,
      amount: { amountMinor: ids.payment.amountMinor, currency: ids.payment.currency },
    });
  });
});
