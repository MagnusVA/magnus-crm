/**
 * Every lead gen prospect is a person (docs/plans/phase-2-person-first.md
 * §4.1).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { bookingHarness, bookingPayload, qualifiedLifecycle } from "../../tests/bookingHarness";
import { countLeadStageEntries, syncLeadStageEntries } from "../lib/leadLifecycle";
import { countProspectConversions } from "../lib/prospectConversions";
import type { LifecycleStage } from "../leads/lifecycle";

afterEach(() => vi.useRealTimers());

type Harness = Awaited<ReturnType<typeof bookingHarness>>;

const NOW = Date.parse("2026-10-10T12:00:00Z");
const ALL_TIME = [0, Number.MAX_SAFE_INTEGER] as const;

async function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  return await bookingHarness();
}

async function capture(harness: Harness, handle: string) {
  return await harness.admin.mutation(api.leadGen.capture.submit, {
    source: "instagram",
    rawHandleOrProfileUrl: `@${handle}`,
    originKind: "follower",
  });
}

async function qualify(harness: Harness, handle: string, submittedAt: number) {
  const installationId = await harness.t.run(async (ctx) =>
    await ctx.db.insert("slackInstallations", {
      tenantId: harness.tenantId, teamId: "T1", teamName: "Team", isEnterpriseInstall: false,
      appId: "A1", botUserId: "B1", botAccessToken: "xoxb", scopes: [], notifyChannelId: "C1",
      notifyChannelName: "qualified", installedByWorkosUserId: "user_slack", installedAt: 0,
      tokenExpiresAt: 0, refreshToken: "r", status: "active",
    }),
  );
  await harness.t.mutation(internal.slack.createQualifiedLead.create, {
    tenantId: harness.tenantId,
    installationId,
    fullName: "Ana Lead",
    handle,
    country: "Honduras",
    leadType: "pt",
    qualifiedBy: { slackUserId: "U1", slackTeamId: "T1", submittedAt },
  });
  await harness.t.finishAllScheduledFunctions(vi.runAllTimers);
}

async function leads(harness: Harness) {
  return await harness.t.run((ctx) => ctx.db.query("leads").take(100));
}

async function totalLeads(harness: Harness) {
  return await harness.t.run(async (ctx) => (await ctx.db.query("tenantStats").first())?.totalLeads ?? 0);
}

async function stageCount(harness: Harness, stage: LifecycleStage) {
  return await harness.t.run((ctx) =>
    countLeadStageEntries(ctx, harness.tenantId, stage, ...ALL_TIME),
  );
}

async function conversions(harness: Harness, workerId: Id<"leadGenWorkers">) {
  return await harness.t.run(async (ctx) => {
    const counts: Partial<Record<LifecycleStage, number>> = {};
    for (const stage of ["prospect", "in_conversation", "qualified", "booked"] as const) {
      counts[stage] = await countProspectConversions(ctx, harness.tenantId, workerId, stage, ...ALL_TIME);
    }
    return counts;
  });
}

async function events(harness: Harness, eventType: string) {
  return await harness.t.run(async (ctx) =>
    (await ctx.db.query("domainEvents").take(500)).filter((event) => event.eventType === eventType),
  );
}

async function onlyProspect(harness: Harness) {
  return await harness.t.run(async (ctx) => {
    const prospects = await ctx.db.query("leadGenProspects").take(2);
    expect(prospects).toHaveLength(1);
    return prospects[0];
  });
}

describe("lead gen capture", () => {
  it("creates the person at Prospect, outside the lead counts", async () => {
    const harness = await setup();

    const result = await capture(harness, "ana.lead");

    const [lead] = await leads(harness);
    const prospect = await onlyProspect(harness);
    expect(result.leadId).toBe(lead._id);
    expect(prospect.leadId).toBe(lead._id);
    expect(lead).toMatchObject({
      lifecycleStage: "prospect",
      lifecycleStageEnteredAt: { prospect: NOW },
      socialHandles: [{ type: "instagram", handle: "ana.lead" }],
      status: "active",
    });
    expect(await totalLeads(harness)).toBe(0);
    expect(await stageCount(harness, "prospect")).toBe(1);
    expect(await stageCount(harness, "qualified")).toBe(0);
    expect(await conversions(harness, prospect.firstCapturedByWorkerId)).toEqual({
      prospect: 1, in_conversation: 0, qualified: 0, booked: 0,
    });
    const searchRow = await harness.t.run((ctx) => ctx.db.query("leadCustomerSearchRows").first());
    expect(searchRow).toMatchObject({ lifecycle: "prospect", isSearchVisible: false });

    expect(await events(harness, "lead.created")).toHaveLength(1);
    const [captured] = await events(harness, "lead.captured");
    expect(captured).toMatchObject({ leadId: lead._id, source: "pipeline", occurredAt: NOW });
    expect(captured.teamMemberId).toBeDefined();
    expect(JSON.parse(captured.metadata!)).toMatchObject({
      submissionId: result.submissionId,
      prospectId: prospect._id,
      source: "instagram",
      originKind: "follower",
    });
  });

  it("is one person across repeat captures, with a touch for each", async () => {
    const harness = await setup();

    await capture(harness, "ana.lead");
    vi.setSystemTime(new Date(NOW + 60_000));
    await capture(harness, "ana.lead");

    expect(await leads(harness)).toHaveLength(1);
    expect(await events(harness, "lead.captured")).toHaveLength(2);
    expect(await events(harness, "lead.created")).toHaveLength(1);
  });

  it("finds the person who already holds the handle, and credits only later stages", async () => {
    const harness = await setup();
    await qualify(harness, "ana.lead", NOW - 5_000);
    vi.setSystemTime(new Date(NOW + 1_000));

    await capture(harness, "ana.lead");

    const [lead] = await leads(harness);
    const prospect = await onlyProspect(harness);
    expect(prospect.leadId).toBe(lead._id);
    // Captured after the qualification: the stage and its times stay.
    expect(lead.lifecycleStageEnteredAt).toEqual({
      prospect: NOW - 5_000,
      in_conversation: NOW - 5_000,
      qualified: NOW - 5_000,
    });
    expect(await events(harness, "lead.created")).toHaveLength(0);
    expect(await conversions(harness, prospect.firstCapturedByWorkerId)).toEqual({
      prospect: 1, in_conversation: 0, qualified: 0, booked: 0,
    });
  });

  it("moves to Qualified then Booked as the same person, counted once", async () => {
    const harness = await setup();
    await capture(harness, "ana.lead");
    const prospect = await onlyProspect(harness);

    await qualify(harness, "ana.lead", NOW + 1_000);

    let [lead] = await leads(harness);
    expect(await leads(harness)).toHaveLength(1);
    expect(lead.lifecycleStage).toBe("qualified");
    expect(lead.lifecycleStageEnteredAt.prospect).toBe(NOW);
    expect(await totalLeads(harness)).toBe(1);
    expect(await stageCount(harness, "qualified")).toBe(1);

    await harness.t.run(async (ctx) => {
      await ctx.db.patch("leads", lead._id, { email: "lead@example.com" });
      await ctx.db.insert("leadIdentifiers", {
        tenantId: harness.tenantId, leadId: lead._id, type: "email", value: "lead@example.com",
        rawValue: "lead@example.com", source: "manual_entry", confidence: "verified", createdAt: NOW,
      });
    });
    vi.setSystemTime(new Date("2026-10-11T12:00:00Z"));
    const payload = bookingPayload("after-capture");
    await harness.t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
      tenantId: harness.tenantId,
      calendlyEventUri: payload.uri,
      eventType: "invitee.created",
      payload: JSON.stringify({ created_at: "2026-10-11T11:00:00Z", payload }),
    });
    await harness.t.finishAllScheduledFunctions(vi.runAllTimers);

    [lead] = await leads(harness);
    expect(await leads(harness)).toHaveLength(1);
    expect(lead.lifecycleStage).toBe("booked");
    expect(await totalLeads(harness)).toBe(1);
    expect(await stageCount(harness, "qualified")).toBe(1);
    expect(await stageCount(harness, "booked")).toBe(1);
    expect(await conversions(harness, prospect.firstCapturedByWorkerId)).toEqual({
      prospect: 1, in_conversation: 1, qualified: 1, booked: 1,
    });
  });

  it("refuses a handle two persons hold, until an admin merges them", async () => {
    const harness = await setup();
    await harness.t.run(async (ctx) => {
      for (const at of [1, 2]) {
        await existingLead(ctx, harness.tenantId, "ana.lead", NOW - at);
      }
    });

    await expect(capture(harness, "ana.lead")).rejects.toThrow(/more than one person/);
    expect(await harness.t.run((ctx) => ctx.db.query("leadGenSubmissions").take(1))).toEqual([]);
  });

  it("asks for a repair, not a merge, when the handle's identifier points at a missing person", async () => {
    const harness = await setup();
    await harness.t.run(async (ctx) => {
      const leadId = await existingLead(ctx, harness.tenantId, "ana.lead", NOW - 1);
      await ctx.db.delete("leads", leadId);
    });

    await expect(capture(harness, "ana.lead")).rejects.toThrow(/needs repair/);
  });

  it("voiding a submission is a touch on the person", async () => {
    const harness = await setup();
    const { submissionId, leadId } = await capture(harness, "ana.lead");

    await harness.admin.mutation(api.leadGen.corrections.voidSubmission, {
      submissionId,
      reason: "Wrong handle",
    });

    const [voided] = await events(harness, "lead.capture_voided");
    expect(voided).toMatchObject({ leadId, reason: "Wrong handle", source: "admin" });
  });
});

async function existingLead(ctx: MutationCtx, tenantId: Id<"tenants">, handle: string, qualifiedAt: number) {
  const lifecycle = qualifiedLifecycle(qualifiedAt);
  const leadId = await ctx.db.insert("leads", {
    tenantId, status: "active", firstSeenAt: qualifiedAt, updatedAt: qualifiedAt,
    socialHandles: [{ type: "instagram", handle }], ...lifecycle,
    lifecycleStageEnteredAt: { prospect: qualifiedAt, in_conversation: qualifiedAt, qualified: qualifiedAt },
  });
  await syncLeadStageEntries(ctx, tenantId, leadId, null, {
    stage: "qualified",
    enteredAt: { prospect: qualifiedAt, in_conversation: qualifiedAt, qualified: qualifiedAt },
  });
  await ctx.db.insert("leadIdentifiers", {
    tenantId, leadId, type: "instagram", value: handle, rawValue: handle,
    source: "slack_qualified", confidence: "verified", createdAt: qualifiedAt,
  });
  // The qualification the stage comes from.
  await ctx.db.insert("opportunities", {
    tenantId, leadId, status: "qualified_pending", source: "slack_qualified", qualifiedAt,
    qualifiedBy: { slackUserId: "U1", slackTeamId: "T1", submittedAt: qualifiedAt },
    createdAt: qualifiedAt, updatedAt: qualifiedAt,
  });
  return leadId;
}
