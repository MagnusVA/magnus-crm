/**
 * Every lead gen prospect is a person (docs/plans/phase-2-person-first.md
 * §4.1, §10.1, §10.2).
 */
import migrationsTest from "@convex-dev/migrations/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { bookingHarness, bookingPayload, qualifiedLifecycle } from "../../tests/bookingHarness";
import { countLeadStageEntries, syncLeadStageEntries } from "../lib/leadLifecycle";
import { countProspectConversions } from "../lib/prospectConversions";
import type { LifecycleStage } from "../leads/lifecycle";
import { migrations } from "../migrations";

afterEach(() => vi.useRealTimers());

type Harness = Awaited<ReturnType<typeof bookingHarness>>;

const NOW = Date.parse("2026-10-10T12:00:00Z");
const ALL_TIME = [0, Number.MAX_SAFE_INTEGER] as const;

async function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  const harness = await bookingHarness();
  migrationsTest.register(harness.t);
  return harness;
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

// --- Backfill (§10.1, §10.2). ---

async function workerId(ctx: MutationCtx, tenantId: Id<"tenants">) {
  const user = (await ctx.db
    .query("users")
    .withIndex("by_workosUserId", (q) => q.eq("workosUserId", "user_admin"))
    .unique())!;
  const existing = await ctx.db
    .query("leadGenWorkers")
    .withIndex("by_tenantId_and_userId", (q) => q.eq("tenantId", tenantId).eq("userId", user._id))
    .unique();
  return (
    existing?._id ??
    (await ctx.db.insert("leadGenWorkers", {
      tenantId, userId: user._id, workosUserId: "user_admin", email: "admin@example.com",
      isActive: true, createdAt: 0, updatedAt: 0,
    }))
  );
}

/** A prospect and its submissions as they were before Phase 2: no person. */
async function legacyProspect(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  handle: string,
  capturedAt: number,
  fields: Partial<Doc<"leadGenProspects">> = {},
) {
  const worker = await workerId(ctx, tenantId);
  const user = (await ctx.db.get("leadGenWorkers", worker))!.userId;
  const prospectId = await ctx.db.insert("leadGenProspects", {
    tenantId, firstSource: "instagram", latestSource: "instagram",
    dedupeKey: `instagram:${handle}`, normalizedHandle: handle, rawHandle: handle,
    profileUrl: `https://instagram.com/${handle}`, firstCapturedByWorkerId: worker,
    firstCapturedAt: capturedAt, lastSubmittedByWorkerId: worker, lastSubmittedAt: capturedAt,
    latestOriginKind: "follower", contactAttemptCount: 1, distinctWorkerCount: 1,
    createdAt: capturedAt, updatedAt: capturedAt, ...fields,
  });
  const submissionId = await ctx.db.insert("leadGenSubmissions", {
    tenantId, prospectId, workerId: worker, userId: user, source: "instagram",
    originKind: "follower", originRankable: true, submittedAt: capturedAt, createdAt: capturedAt,
  });
  return { prospectId, submissionId, worker };
}

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

async function run(harness: Harness, name: string, reset = false) {
  await harness.t.mutation(internal.migrations.run, { fn: `migrations:${name}`, reset });
  await harness.t.finishAllScheduledFunctions(vi.runAllTimers);
  const [status] = await harness.t.run((ctx) =>
    migrations.getStatus(ctx, { migrations: [`migrations:${name}`] as never }),
  );
  return status;
}

describe("prospect backfill", () => {
  it("links each prospect by audit match, then handle, then a new person, and the asserts pass", async () => {
    const harness = await setup();
    const { tenantId } = harness;
    const CAPTURED = NOW - 10 * 86_400_000;
    const QUALIFIED = NOW - 5 * 86_400_000;
    const ids = await harness.t.run(async (ctx) => {
      // Matched by Slack before Phase 2.
      const matchedLeadId = await existingLead(ctx, tenantId, "matched.one", QUALIFIED);
      const matched = await legacyProspect(ctx, tenantId, "matched.one", CAPTURED);
      const matchId = await ctx.db.insert("leadGenAuditMatches", {
        tenantId, prospectId: matched.prospectId, leadId: matchedLeadId, matchSource: "slack_qualification",
        matchStatus: "accepted", matchedVia: "social_handle", normalizedHandle: "matched.one",
        createdAt: QUALIFIED, updatedAt: QUALIFIED,
      });
      await ctx.db.patch("leadGenProspects", matched.prospectId, { currentAuditMatchId: matchId });
      // Captured before the person was qualified, never matched.
      const handleLeadId = await existingLead(ctx, tenantId, "handle.only", QUALIFIED);
      const byHandle = await legacyProspect(ctx, tenantId, "handle.only", CAPTURED);
      // Nobody holds the handle.
      const fresh = await legacyProspect(ctx, tenantId, "brand.new", CAPTURED);
      // A placeholder handle, captured before the form rejected them.
      const placeholder = await legacyProspect(ctx, tenantId, "na", CAPTURED);
      await ctx.db.patch("leadGenSubmissions", placeholder.submissionId, {
        voidedAt: CAPTURED + 1, voidReason: "Placeholder",
      });
      await ctx.db.insert("tenantStats", {
        tenantId, totalTeamMembers: 2, totalClosers: 1, totalOpportunities: 0, activeOpportunities: 0,
        wonDeals: 0, lostDeals: 0, totalRevenueMinor: 0, totalPaymentRecords: 0, totalLeads: 2,
        totalCustomers: 0, lastUpdatedAt: 0,
      });
      return { matchedLeadId, handleLeadId, matched, byHandle, fresh, placeholder };
    });

    expect((await run(harness, "linkProspectPeople")).state).toBe("success");
    expect((await run(harness, "assertProspectPeople")).state).toBe("success");
    expect((await run(harness, "backfillCaptureEvents")).state).toBe("success");
    // Running it again writes nothing new.
    expect((await run(harness, "backfillCaptureEvents", true)).state).toBe("success");
    expect((await run(harness, "assertCaptureEvents")).state).toBe("success");
    expect((await run(harness, "assertLeadLifecycle")).state).toBe("success");

    const state = await harness.t.run(async (ctx) => ({
      matched: await ctx.db.get("leadGenProspects", ids.matched.prospectId),
      byHandle: await ctx.db.get("leadGenProspects", ids.byHandle.prospectId),
      fresh: await ctx.db.get("leadGenProspects", ids.fresh.prospectId),
      placeholder: await ctx.db.get("leadGenProspects", ids.placeholder.prospectId),
      handleLead: await ctx.db.get("leads", ids.handleLeadId),
      leads: await ctx.db.query("leads").take(10),
      identifiers: await ctx.db.query("leadIdentifiers").take(10),
    }));
    expect(state.matched?.leadId).toBe(ids.matchedLeadId);
    expect(state.byHandle?.leadId).toBe(ids.handleLeadId);
    // Captured first: the Prospect time moves earlier, the stage stays.
    expect(state.handleLead).toMatchObject({
      lifecycleStage: "qualified",
      lifecycleStageEnteredAt: { prospect: CAPTURED, in_conversation: QUALIFIED, qualified: QUALIFIED },
    });
    expect(state.leads).toHaveLength(4);
    const freshLead = state.leads.find((lead) => lead._id === state.fresh?.leadId);
    expect(freshLead).toMatchObject({ lifecycleStage: "prospect", lifecycleStageEnteredAt: { prospect: CAPTURED } });
    const placeholderLead = state.leads.find((lead) => lead._id === state.placeholder?.leadId);
    expect(placeholderLead).toMatchObject({ lifecycleStage: "prospect" });
    expect(state.identifiers.filter((identifier) => identifier.leadId === placeholderLead?._id)).toEqual([]);

    expect(await totalLeads(harness)).toBe(2);
    expect(await stageCount(harness, "prospect")).toBe(4);
    expect(await stageCount(harness, "qualified")).toBe(2);
    expect(await conversions(harness, ids.fresh.worker)).toEqual({
      prospect: 4, in_conversation: 2, qualified: 2, booked: 0,
    });
    expect(await events(harness, "lead.captured")).toHaveLength(4);
    expect(await events(harness, "lead.capture_voided")).toHaveLength(1);
    expect(await events(harness, "lead.created")).toHaveLength(0);
  });

  it("fails the assert for a prospect with no person", async () => {
    const harness = await setup();
    await harness.t.run((ctx) => legacyProspect(ctx, harness.tenantId, "brand.new", NOW));

    const status = await run(harness, "assertProspectPeople");

    expect(status.state).toBe("failed");
  });
});
