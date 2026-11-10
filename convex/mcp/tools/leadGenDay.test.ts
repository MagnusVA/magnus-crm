import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FunctionReturnType } from "convex/server";
import { api, internal } from "../../_generated/api";
import { reportDefinitionFor, resolveReportRequest } from "../../analytics/keys";
import { mergeMyActivitySummary } from "../../analytics/merge/leadGen";
import { callTool, createMcpHarness, mcpConnect, seedTenantWithLeadGen, type McpHarness } from "../../../tests/mcpHarness";
import { LEAD_GEN_NOW, LEAD_GEN_TIME_ZONE, seedLeadGenReads } from "../../../tests/leadGenReadFixtures";

import { formatLocal } from "../time";

const local = (ms: number) => formatLocal(ms, LEAD_GEN_TIME_ZONE);

type Today = FunctionReturnType<typeof internal.mcp.tools.leadGenToday.run>;
type Activity = FunctionReturnType<typeof internal.mcp.tools.leadGenActivity.myActivity>;
type Batch = FunctionReturnType<typeof internal.mcp.tools.leadGenRespark.batch>;
type People = FunctionReturnType<typeof internal.mcp.tools.leadGenRespark.person>;
const todayRange = { kind: "custom" as const, startBusinessDate: "2026-11-09", endBusinessDateInclusive: "2026-11-09" };

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(LEAD_GEN_NOW); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function connect(h: McpHarness, orgId: string, sub = "user_sofia") {
  const token = await h.signToken(sub, { org_id: orgId });
  const { sessionId } = await mcpConnect(h.t, token);
  return async <T>(name: string, args: Record<string, unknown> = {}) => {
    const result = await callTool(h.t, token, sessionId, name, args);
    expect(result.response.body?.error, result.text).toBeUndefined();
    expect(result.isError, result.text).toBe(false);
    return result.data as T;
  };
}

function privateDataAbsent(value: unknown) {
  const json = JSON.stringify(value);
  for (const secret of ["payment.recorded", "alice@gmail.com", "+50499999912", "Dani Cruz", "profilePicture", "previewImage"]) expect(json).not.toContain(secret);
  expect(new TextEncoder().encode(json).byteLength).toBeLessThanOrEqual(65_536);
}

async function warehouse(h: McpHarness, seed: Awaited<ReturnType<typeof seedLeadGenReads>>, status: "ready" | "queued" | "failed" | "pending", end = "2026-11-08") {
  vi.stubEnv("CLICKHOUSE_URL", "https://warehouse.invalid");
  vi.stubEnv("CLICKHOUSE_USER", "test");
  vi.stubEnv("CLICKHOUSE_PASSWORD", "test");
  if (status === "queued") vi.stubEnv("ANALYTICS_DAILY_RUN_BUDGET", "0");
  const range = { kind: "custom" as const, startDate: "2026-11-02", endDateInclusive: end };
  const history = await seed.sofia.query(api.leadGen.activity.getMyActivitySummary, {
    range: { kind: "custom", startBusinessDate: range.startDate, endBusinessDateInclusive: end },
  });
  const resultId = await h.t.run(async ctx => {
    await ctx.db.patch("tenants", seed.tenantId, { analyticsReports: ["my_activity"] });
    const viewer = { tenantId: seed.tenantId, userId: seed.sofiaId, role: "lead_generator" as const, workosUserId: "user_sofia" };
    const request = await resolveReportRequest(ctx, { reportId: "my_activity.summary", filters: {}, range, timeZone: "America/Tegucigalpa" }, reportDefinitionFor("my_activity.summary"), viewer);
    const payloadId = await ctx.db.insert("analyticsPayloads", { tenantId: seed.tenantId, json: JSON.stringify(history) });
    return ctx.db.insert("analyticsResults", { tenantId: seed.tenantId, reportId: "my_activity.summary",
      argsKey: request.argsKey, filtersJson: request.filtersJson, range, timeZone: request.day.timeZone, dayStartHour: request.day.dayStartHour,
      status, lastRequestedAt: LEAD_GEN_NOW, payloadId,
      answer: { watermark: LEAD_GEN_NOW - 1000, startDate: range.startDate, endDateInclusive: end, completedAt: LEAD_GEN_NOW - 1000 },
      ...(status === "failed" ? { failedAt: LEAD_GEN_NOW, errorMessage: "Warehouse unavailable" } : {}),
      ...(status === "pending" ? { run: { id: "inflight", watermark: LEAD_GEN_NOW, startedAt: LEAD_GEN_NOW, executingAt: LEAD_GEN_NOW } } : {}),
    });
  });
  return { history, resultId, range };
}

describe("lead gen reads through /mcp", () => {
  it("matches the web's today, respark and activity calculations and flags voided captures only for MCP", async () => {
    const h = await createMcpHarness(); const seed = await seedLeadGenReads(h);
    const tool = await connect(h, seed.orgId);
    const today = await tool<Today>("magnus_lead_gen_today");
    const day = await seed.sofia.query(api.leadGen.activity.getMyDaySummary, { dayKey: "2026-11-09" });
    const respark = await seed.sofia.query(api.respark.queries.getMyResparkToday, {});
    const pool = await seed.sofia.query(api.respark.queries.getResparkPoolCounts, {});
    expect(today.asOf).toBe(local(LEAD_GEN_NOW));
    expect(today.dayKey).toBe("2026-11-09");
    expect(today.profile).toMatchObject({ status: "active", noTeam: false });
    expect(today.counts).toMatchObject({ today: day.submissions, unique: day.uniqueProspects, dupes: day.duplicates, scheduledHours: 6,
      respark: { batchesDone: respark.batchesDone, resparks: respark.resparks, notAFits: respark.notAFits }, pool: pool.buckets, batchSize: pool.batchSize, heldUntil: local(pool.heldUntil),
      openBatch: { progress: { total: 3, worked: 2, remaining: 1 }, heldUntil: local(seed.items[0].heldUntil) },
      lastOrigin: { kind: "follower", usedAt: local(LEAD_GEN_NOW) } });
    const activity = await tool<Activity>("magnus_my_lead_gen_activity");
    const summary = await seed.sofia.query(api.leadGen.activity.getMyActivitySummary, { range: todayRange });
    expect(activity).toMatchObject({ state: "ready", source: "live", asOf: local(LEAD_GEN_NOW), numbers: { rawLeads: summary.submissions,
      resparks: summary.resparks, entries: summary.entries, notAFit: summary.notAFit, scheduledHours: summary.scheduledHours, leadsPerHour: summary.leadsPerHour } });
    expect(activity.recent.find(row => row.id === seed.captures[2].submissionId)?.voided).toBe(true);
    const webRecent = await seed.sofia.query(api.leadGen.activity.listMyRecentSubmissions, { range: todayRange, paginationOpts: { numItems: 25, cursor: null } });
    for (const row of activity.recent) {
      const webRow = webRecent.page.find(entry => entry._id === row.id)!;
      expect(row.submittedAt).toBe(local(webRow.submittedAt));
    }
    expect(webRecent.page.every(row => !("voided" in row))).toBe(true);
    privateDataAbsent(today); privateDataAbsent(activity);
  });

  it("projects safe batch cards and wraps masked panel text without changing the web", async () => {
    const h = await createMcpHarness(); const seed = await seedLeadGenReads(h); const tool = await connect(h, seed.orgId);
    const batch = await tool<Batch>("magnus_respark_batch");
    expect(batch).toMatchObject({ asOf: local(LEAD_GEN_NOW), heldUntil: local(seed.items[0].heldUntil) });
    expect(batch.items).toHaveLength(3);
    expect(batch.items.find(item => item.itemId === seed.items[0]._id)).toMatchObject({ handle: "held.person", capturedBy: "a teammate", newestDealOutcome: "lost" });
    const web = await seed.sofia.query(api.respark.queries.getMyResparkBatch, {});
    for (const item of batch.items) {
      const webItem = web!.items.find(entry => entry.itemId === item.itemId)!;
      expect(item.capturedAt).toBe(local(webItem.person!.capturedAt!));
      expect(item.lastTouches.length).toBeGreaterThan(0);
      for (const touch of item.lastTouches) expect(touch.occurredAt).toBe(local(
        webItem.person!.lastTouches.find(entry => entry.eventId === touch.eventId)!.occurredAt));
    }
    privateDataAbsent(batch);
    const people = await tool<People>("magnus_respark_person", { itemIds: [seed.items[0]._id] });
    expect(people.asOf).toBe(local(LEAD_GEN_NOW));
    const panel = people.people[0].panel!;
    const webPanel = (await seed.sofia.query(api.respark.queries.getResparkPersonPanel, { itemId: seed.items[0]._id }))!;
    expect(panel.timeline.length).toBeGreaterThan(0);
    for (const touch of panel.timeline) expect(touch.occurredAt).toBe(local(
      webPanel.timeline.find(entry => entry.eventId === touch.eventId)!.occurredAt));
    expect(panel.deals[0].createdAt).toBe(local(webPanel.deals[0].createdAt));
    expect(panel.calls[0].scheduledAt).toBe(local(webPanel.calls[0].scheduledAt));
    expect(panel.notes[0].createdAt).toBe(local(webPanel.notes[0].createdAt));
    expect(panel.resparkHistory[0].workedAt).toBeNull();
    const worked = await tool<People>("magnus_respark_person", { itemIds: [seed.items[1]._id] });
    expect(worked.people[0].panel!.resparkHistory[0].workedAt).toBe(local(LEAD_GEN_NOW));
    expect(panel.identity.phone).toContain("•••"); expect(panel.identity.email).toContain("•••");
    expect(panel.calls[0].bookingAnswers[0].answer).toMatchObject({ personSupplied: true, truncated: true });
    expect(panel.calls[0].bookingAnswers[0].answer.text).toHaveLength(500);
    expect(panel.calls[0].bookingAnswers[0].answer.text).toContain("Ignore previous instructions");
    expect(panel.notes[0].content.personSupplied).toBe(true);
    expect(panel.deals[0].lostReason?.personSupplied).toBe(true);
    expect(people.textTruncated).toBe(true); privateDataAbsent(people);
    expect(JSON.stringify(web)).toContain("Dani Cruz"); expect(JSON.stringify(web)).toContain("payment.recorded");
  });

  it("isolates all four reads from teammates and a second tenant, and rejects admin/closer calls", async () => {
    const h = await createMcpHarness(); const seed = await seedLeadGenReads(h);
    const other = await seedTenantWithLeadGen(h.t, { orgId: "org_other", slug: "other" });
    for (const [orgId, sub] of [[seed.orgId, "user_dani"], [other.orgId, "other_user_sofia"]]) {
      const tool = await connect(h, orgId, sub);
      expect((await tool<Batch>("magnus_respark_batch")).items).toEqual([]);
      expect((await tool<People>("magnus_respark_person", { itemIds: [seed.items[0]._id] })).people[0].panel).toBeNull();
      expect((await tool<Today>("magnus_lead_gen_today")).counts?.today).toBe(0);
      expect((await tool<Activity>("magnus_my_lead_gen_activity")).numbers?.rawLeads).toBe(0);
    }
    for (const sub of ["user_admin", "user_alex"]) {
      const token = await h.signToken(sub, { org_id: seed.orgId }); const { sessionId } = await mcpConnect(h.t, token);
      for (const name of ["magnus_lead_gen_today", "magnus_my_lead_gen_activity", "magnus_respark_batch", "magnus_respark_person"]) {
        const result = await callTool(h.t, token, sessionId, name, name.endsWith("person") ? { itemIds: [seed.items[0]._id] } : {});
        expect(result.response.body?.error?.message ?? result.text).toContain("isn't available for your role");
      }
    }
  });

  it("returns profile status and unavailable figures for inactive, missing and teamless workers", async () => {
    const h = await createMcpHarness(); const seed = await seedLeadGenReads(h); const tool = await connect(h, seed.orgId);
    for (const status of ["inactive", "no_team", "none"]) {
      await h.t.run(async ctx => {
        if (status === "none") await ctx.db.delete("leadGenWorkers", seed.sofiaWorkerId);
        else await ctx.db.patch("leadGenWorkers", seed.sofiaWorkerId, status === "inactive" ? { isActive: false } : { isActive: true, teamId: undefined });
      });
      const today = await tool<Today>("magnus_lead_gen_today");
      expect(today.asOf).toBe(local(LEAD_GEN_NOW));
      expect(today.unavailableReason).toBe(status); expect(today.counts).toBeNull();
      expect((await tool<Activity>("magnus_my_lead_gen_activity")).numbers).toBeNull();
      expect((await tool<Batch>("magnus_respark_batch")).items).toEqual([]);
      expect((await tool<People>("magnus_respark_person", { itemIds: [seed.items[0]._id] })).people[0].panel).toBeNull();
    }
  });

  it("merges warehouse history and today with web parity, and keeps a single past day live", async () => {
    const h = await createMcpHarness(); const seed = await seedLeadGenReads(h);
    // A nonzero historical day makes losing either half of the merge visible.
    await h.t.run(ctx => ctx.db.insert("leadGenDailyStats", { tenantId: seed.tenantId, workerId: seed.sofiaWorkerId,
      userId: seed.sofiaId, statKey: "historical", dayKey: "2026-11-03", source: "instagram", submissions: 7,
      uniqueProspectsSubmitted: 7, duplicateProspectSubmissions: 0, scheduledHours: 6, updatedAt: LEAD_GEN_NOW }));
    const { history } = await warehouse(h, seed, "ready"); const tool = await connect(h, seed.orgId);
    const expected = mergeMyActivitySummary(history, await seed.sofia.query(api.leadGen.activity.getMyActivitySummary, { range: todayRange }));
    const activity = await tool<Activity>("magnus_my_lead_gen_activity", { startDate: "2026-11-02", endDate: "2026-11-09" });
    expect(activity).toMatchObject({ state: "ready", source: "warehouse", asOf: local(LEAD_GEN_NOW - 1000),
      numbers: { rawLeads: expected.submissions, resparks: expected.resparks, entries: expected.entries,
        notAFit: expected.notAFit, scheduledHours: expected.scheduledHours, leadsPerHour: expected.leadsPerHour } });
    expect((await tool<Activity>("magnus_my_lead_gen_activity", { startDate: "2026-11-03", endDate: "2026-11-03" })).source).toBe("live");
    const past = await tool<Activity>("magnus_my_lead_gen_activity", { startDate: "2026-11-02", endDate: "2026-11-08" });
    expect(past).toMatchObject({ source: "warehouse", state: "ready", asOf: local(LEAD_GEN_NOW - 1000), numbers: { rawLeads: 7 } });
    privateDataAbsent(activity);
  });

  it.each(["queued", "failed"] as const)("returns no figures for a %s warehouse, even with an older payload", async status => {
    const h = await createMcpHarness(); const seed = await seedLeadGenReads(h); await warehouse(h, seed, status);
    const tool = await connect(h, seed.orgId);
    const result = await tool<Activity>("magnus_my_lead_gen_activity", { startDate: "2026-11-02", endDate: "2026-11-09" });
    expect(result.state).toBe(status === "queued" ? "pending" : "failed"); expect(result.numbers).toBeNull(); expect(result.recent).toEqual([]); expect(result.asOf).toBeNull();
  });

  it("pages batch items and activity without gaps, and binds cursors to the owner and range", async () => {
    const h = await createMcpHarness(); const seed = await seedLeadGenReads(h); const tool = await connect(h, seed.orgId);
    await h.t.run(async ctx => {
      await ctx.db.patch("resparkBatches", seed.items[0].batchId, { size: 30 });
      for (let position = 3; position < 30; position++) {
        await ctx.db.insert("resparkBatchItems", { tenantId: seed.tenantId, batchId: seed.items[0].batchId,
          leadId: seed.leadId, userId: seed.sofiaId, workerId: seed.sofiaWorkerId, position,
          bucket: 1, heldUntil: seed.items[0].heldUntil });
      }
      for (let index = 0; index < 30; index++) await ctx.db.insert("leadGenSubmissions", {
        tenantId: seed.tenantId, workerId: seed.sofiaWorkerId, userId: seed.sofiaId,
        prospectId: seed.captures[0].prospectId, source: "instagram", originKind: "story", originRankable: false,
        originValue: "x".repeat(800), submittedAt: LEAD_GEN_NOW - index * 1000, createdAt: LEAD_GEN_NOW,
      });
    });
    const first = await tool<Batch>("magnus_respark_batch");
    expect(first.items).toHaveLength(25); expect(first.cursor).toBeTruthy();
    expect(first.items.length + first.items.reduce((sum, item) => sum + item.lastTouches.length, 0)).toBeLessThanOrEqual(50);
    const second = await tool<Batch>("magnus_respark_batch", { cursor: first.cursor });
    expect(second.items).toHaveLength(5); expect(second.cursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map(item => item.itemId)).size).toBe(30);
    const activity = await tool<Activity>("magnus_my_lead_gen_activity");
    expect(activity.recent).toHaveLength(25); expect(activity.cursor).toBeTruthy();
    const activity2 = await tool<Activity>("magnus_my_lead_gen_activity", { cursor: activity.cursor });
    expect(new Set([...activity.recent, ...activity2.recent].map(row => row.id)).size).toBe(35);
    expect(activity2.cursor).toBeNull(); expect(activity.textTruncated).toBe(true);
    const token = await h.signToken("user_sofia", { org_id: seed.orgId }); const { sessionId } = await mcpConnect(h.t, token);
    const wrongRange = await callTool(h.t, token, sessionId, "magnus_my_lead_gen_activity", {
      startDate: "2026-11-08", endDate: "2026-11-09", cursor: activity.cursor,
    });
    expect(wrongRange.isError).toBe(true);
    const daniToken = await h.signToken("user_dani", { org_id: seed.orgId }); const daniSession = await mcpConnect(h.t, daniToken);
    const foreignActivity = await callTool(h.t, daniToken, daniSession.sessionId, "magnus_my_lead_gen_activity", { cursor: activity.cursor });
    expect(foreignActivity.isError).toBe(true);
    privateDataAbsent(first); privateDataAbsent(second); privateDataAbsent(activity);
  });

  it("bounds nested panel rows across five people and refuses expired or foreign-team panels", async () => {
    const h = await createMcpHarness(); const seed = await seedLeadGenReads(h); const tool = await connect(h, seed.orgId);
    await h.t.run(async ctx => {
      for (let i = 0; i < 55; i++) await ctx.db.insert("leadNotes", { tenantId: seed.tenantId,
        leadId: seed.leadId, authorKind: "user", userId: seed.sofiaId, content: "😀".repeat(1000), createdAt: LEAD_GEN_NOW + i });
    });
    const panels = await tool<People>("magnus_respark_person", { itemIds: Array(5).fill(seed.items[0]._id) });
    const countRows = panels.people.reduce((sum, person) => {
      const p = person.panel!;
      return sum + 1 + p.timeline.length + p.deals.length + p.calls.length + p.notes.length + p.resparkHistory.length +
        p.calls.reduce((n, call) => n + call.bookingAnswers.length, 0);
    }, 0);
    expect(countRows).toBeLessThanOrEqual(50); expect(panels.isPartial).toBe(true); privateDataAbsent(panels);
    expect(panels.people[0].panel?.notes[0].content.truncated).toBe(true);
    await h.t.run(ctx => ctx.db.patch("resparkBatches", seed.items[0].batchId, { heldUntil: LEAD_GEN_NOW }));
    expect((await tool<Batch>("magnus_respark_batch")).items).toEqual([]);
    expect((await tool<People>("magnus_respark_person", { itemIds: [seed.items[0]._id] })).people[0].panel).toBeNull();
    await h.t.run(ctx => ctx.db.patch("resparkBatches", seed.items[0].batchId, { heldUntil: LEAD_GEN_NOW + 1000, teamId: undefined }));
    expect((await tool<People>("magnus_respark_person", { itemIds: [seed.items[0]._id] })).people[0].panel).toBeNull();
  });

  it("finishes a delayed warehouse answer with the live figures and recent rows", async () => {
    const h = await createMcpHarness(); const seed = await seedLeadGenReads(h); const { resultId } = await warehouse(h, seed, "pending");
    const tool = await connect(h, seed.orgId);
    const answer = tool<Activity>("magnus_my_lead_gen_activity", { startDate: "2026-11-02", endDate: "2026-11-09" });
    await new Promise(resolve => setTimeout(resolve, 50));
    await h.t.run(ctx => ctx.db.patch("analyticsResults", resultId, { status: "ready", run: undefined }));
    const result = await answer;
    expect(result.asOf).toBe(local(LEAD_GEN_NOW - 1000));
    expect(result.recent.every(row => row.submittedAt === local(LEAD_GEN_NOW))).toBe(true);
    expect(result.state).toBe("ready"); expect(result.numbers?.rawLeads).toBe(2); expect(result.recent).toHaveLength(5);
  });

  it("rechecks access during warehouse polling", async () => {
    const h = await createMcpHarness(); const seed = await seedLeadGenReads(h); await warehouse(h, seed, "pending");
    const token = await h.signToken("user_sofia", { org_id: seed.orgId }); const { sessionId } = await mcpConnect(h.t, token);
    const pending = callTool(h.t, token, sessionId, "magnus_my_lead_gen_activity", { startDate: "2026-11-02", endDate: "2026-11-09" });
    await new Promise(resolve => setTimeout(resolve, 50));
    await h.t.run(ctx => ctx.db.patch("users", seed.sofiaId, { mcpBlockedAt: LEAD_GEN_NOW }));
    const result = await pending;
    expect(result.isError || Boolean(result.response.body?.error)).toBe(true);
    expect(JSON.stringify(result.data)).not.toContain("rawLeads");
  });
});
