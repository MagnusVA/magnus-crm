import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { callTool, createMcpHarness, mcpConnect, seedTenantWithLeadGen } from "../../../tests/mcpHarness";
import { businessDayStart } from "../../../lib/businessDay";
import { syncPersonEnrollments } from "../../lib/enrollments";
import { advanceLeadLifecycle, adminSetDisposition } from "../../lib/leadLifecycle";
import { resparkPool, resparkTeamPool } from "../../lib/respark/state";
import type { ContactAgain } from "../../lib/contactAgain";

const NOW = Date.parse("2026-10-20T15:00:00Z");
const DAY = 86_400_000;
const DATE = "2026-11-01";
const AT = businessDayStart(DATE);
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function fixture() {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
  const h = await createMcpHarness();
  const seed = await seedTenantWithLeadGen(h.t);
  const web = (sub = "user_sofia", org = seed.orgId) => h.t.withIdentity({ subject: sub, org_id: org });
  const tool = async (name: string, args: Record<string, unknown>, sub = "user_sofia", org = seed.orgId) => {
    const token = await h.signToken(sub, { org_id: org });
    const { sessionId } = await mcpConnect(h.t, token);
    const reply = await callTool(h.t, token, sessionId, name, args);
    return { ...reply, isError: reply.isError || Boolean(reply.response.body?.error) };
  };
  const capture = async (handle = "date.person", sub = "user_sofia", at = NOW - 40 * DAY) => {
    vi.setSystemTime(at);
    const result = await web(sub).mutation(api.leadGen.capture.submit, { source: "instagram", rawHandleOrProfileUrl: handle, originKind: "follower" });
    vi.setSystemTime(NOW);
    return { leadId: result.leadId!, submissionId: result.submissionId };
  };
  const set = (args: Record<string, unknown>, sub?: string, org?: string) => tool("magnus_set_contact_again", { date: DATE, note: "Asked for next month", ...args }, sub, org);
  const lead = (id: Id<"leads">) => h.t.run(ctx => ctx.db.get("leads", id));
  const saved = (date = DATE, note = "Asked for next month"): ContactAgain => ({ date, at: businessDayStart(date), timeZone: "America/Tegucigalpa", dayStartHour: 1, note, setByUserId: seed.sofiaId, setAt: NOW });
  const claim = async () => {
    const reply = await tool("magnus_claim_respark_batch", {});
    expect(reply.isError).toBe(false);
    const batchId = (reply.data as { batchId: Id<"resparkBatches"> }).batchId;
    return h.t.run(ctx => ctx.db.query("resparkBatchItems").withIndex("by_batchId_and_position", q => q.eq("batchId", batchId)).take(100));
  };
  return { ...h, ...seed, web, tool, capture, set, lead, saved, claim };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type SetReply = { changed: boolean; contactAgain: { date: string; note: { text: string } | null; withheldReason: string | null } | null };
async function mark(f: Fixture, itemId: Id<"resparkBatchItems">, result: "resparked" | "not_a_fit" | "skipped") {
  const args = { marks: [{ itemId, result }], confirm: false };
  const preview = await f.tool("magnus_mark_respark_items", args);
  expect(preview.isError).toBe(false);
  const data = preview.data as { willRecord: number; confirmToken: string };
  if (data.willRecord) {
    const commit = await f.tool("magnus_mark_respark_items", { ...args, confirm: true, confirmToken: data.confirmToken });
    expect(commit.isError).toBe(false);
  }
  return data;
}

// Synthetic pool rows let boundary tests exercise the actual aggregate/count
// readers without hundreds of unrelated capture writes.
async function poolPeople(f: Fixture, count: number, future: boolean, extra: Partial<Doc<"leads">> = {}) {
  return f.t.run(async ctx => {
    const ids: Id<"leads">[] = [];
    for (let i = 0; i < count; i++) {
      const id = await ctx.db.insert("leads", { tenantId: f.tenantId, status: "active", lifecycleStage: "in_conversation", lifecycleStageEnteredAt: { in_conversation: NOW - 50 * DAY },
        disposition: "open", firstSeenAt: NOW - 50 * DAY, updatedAt: NOW, socialHandles: [{ type: "instagram", handle: `pool.${i}` }], ...extra });
      const eventId = await ctx.db.insert("domainEvents", { tenantId: f.tenantId, entityType: "lead", entityId: id, leadId: id, eventType: "lead.created", occurredAt: NOW - 50 * DAY, source: "pipeline" });
      const occurredAt = NOW - 50 * DAY + i;
      await ctx.db.patch("leads", id, { resparkGroup: "never_qualified", resparkTeamId: f.teamId, lastTouch: { occurredAt, eventId, eventType: "lead.created" }, ...(future && { contactAgain: f.saved() }) });
      await resparkPool.insert(ctx, { namespace: f.tenantId, key: ["never_qualified", occurredAt], id });
      await resparkTeamPool.insert(ctx, { namespace: f.tenantId, key: [f.teamId, "never_qualified", occurredAt], id });
      ids.push(id);
    }
    return ids;
  });
}

describe("contact-again through MCP", () => {
  it("sets, replaces and clears an own capture; repeats emit no event and never change touches", async () => {
    const f = await fixture(); const person = await f.capture();
    const before = await f.lead(person.leadId);
    expect((await f.set({ submissionId: person.submissionId })).data).toMatchObject({ changed: true, contactAgain: { date: DATE } });
    expect((await f.set({ submissionId: person.submissionId })).data).toMatchObject({ changed: false });
    const events = await f.t.run(ctx => ctx.db.query("domainEvents").withIndex("by_tenantId_and_eventType_and_occurredAt", q => q.eq("tenantId", f.tenantId).eq("eventType", "lead.contact_again_changed")).take(10));
    expect(events).toHaveLength(1); expect(events[0].actorUserId).toBe(f.sofiaId);
    expect(JSON.parse(events[0].metadata!)).toMatchObject({ via: "mcp", agentClient: "claude-ai", date: DATE });
    expect(events[0].metadata).not.toContain("Asked");
    expect((await f.lead(person.leadId))?.lastTouch).toEqual(before?.lastTouch);
    expect((await f.lead(person.leadId))?.latestTouch).toEqual(before?.latestTouch);
    expect((await f.set({ submissionId: person.submissionId, date: "2026-12-01", note: "Later" })).isError).toBe(false);
    expect((await f.set({ submissionId: person.submissionId, date: null })).data).toMatchObject({ changed: true, contactAgain: null });
    expect((await f.set({ submissionId: person.submissionId, date: null })).data).toMatchObject({ changed: false });
  });

  it("accepts any own non-voided capture, even when someone else captured first", async () => {
    const f = await fixture(); await f.capture("shared.person", "user_dani");
    const mine = await f.capture("shared.person");
    expect((await f.set({ submissionId: mine.submissionId })).isError).toBe(false);
  });

  it("refuses foreign, voided, inactive, cross-tenant, closer and invalid-date proofs", async () => {
    const f = await fixture(); const mine = await f.capture(); const theirs = await f.capture("their.person", "user_dani");
    expect((await f.set({ submissionId: theirs.submissionId })).isError).toBe(true);
    expect((await f.set({ submissionId: mine.submissionId }, "user_alex")).isError).toBe(true);
    const other = await seedTenantWithLeadGen(f.t, { orgId: "org_other", slug: "other" });
    expect((await f.set({ submissionId: mine.submissionId }, "other_user_sofia", other.orgId)).isError).toBe(true);
    for (const date of ["2026-02-30", "2026-10-20", "yesterday", "2026-10-19"]) expect((await f.set({ submissionId: mine.submissionId, date })).isError).toBe(true);
    expect((await f.set({ submissionId: mine.submissionId, note: " " })).isError).toBe(true);
    expect((await f.set({ submissionId: mine.submissionId, note: "x".repeat(501) })).isError).toBe(true);
    await f.t.run(ctx => ctx.db.patch("leadGenSubmissions", mine.submissionId, { voidedAt: NOW }));
    expect((await f.set({ submissionId: mine.submissionId })).isError).toBe(true);
    await f.t.run(ctx => ctx.db.patch("leadGenWorkers", f.daniWorkerId, { isActive: false }));
    expect((await f.set({ submissionId: theirs.submissionId }, "user_dani")).isError).toBe(true);
  });

  it.each([{ disposition: "do_not_contact" as const }, { lifecycleStage: "customer" as const }, { status: "converted" as const }, { status: "merged" as const }])("refuses setting and clearing a forbidden person %j", async patch => {
    const f = await fixture(); const p = await f.capture();
    await f.t.run(ctx => ctx.db.patch("leads", p.leadId, { ...patch, contactAgain: f.saved() }));
    expect((await f.set({ submissionId: p.submissionId })).isError).toBe(true);
    expect((await f.set({ submissionId: p.submissionId, date: null })).isError).toBe(true);
    expect(await f.web().query(api.leadGen.contactAgain.getContactAgain, { submissionId: p.submissionId })).toMatchObject({ hidden: true, contactAgain: null });
  });

  it("allows an admin without a capture and makes closers read-only", async () => {
    const f = await fixture(); const p = await f.capture("admin.date", "user_dani");
    await f.web("user_admin").mutation(api.leadGen.contactAgain.setContactAgain, { leadId: p.leadId, date: DATE, note: "Alex Rivera agreed on $3,000" });
    expect(await f.web("user_alex").query(api.leadGen.contactAgain.getContactAgain, { leadId: p.leadId })).toMatchObject({ canEdit: false, contactAgain: { note: { text: "Alex Rivera agreed on $3,000" } } });
    await expect(f.web("user_alex").mutation(api.leadGen.contactAgain.setContactAgain, { leadId: p.leadId, date: null })).rejects.toThrow();
    await expect(f.web().query(api.leadGen.contactAgain.getContactAgain, { leadId: p.leadId })).rejects.toThrow();
  });

  it("lets a worked held item save a date without any own capture; expires and team changes refuse", async () => {
    const f = await fixture(); await f.capture("worked.date", "user_dani");
    const [item] = await f.claim();
    await mark(f, item._id, "resparked");
    expect((await f.set({ itemId: item._id })).isError).toBe(false);
    expect((await f.lead(item.leadId))?.contactAgain?.date).toBe(DATE);
    await f.t.run(ctx => ctx.db.patch("leadGenWorkers", f.sofiaWorkerId, { teamId: undefined }));
    expect((await f.set({ itemId: item._id, date: null })).isError).toBe(true);
    await f.t.run(ctx => ctx.db.patch("leadGenWorkers", f.sofiaWorkerId, { teamId: f.teamId }));
    vi.setSystemTime(item.heldUntil);
    expect((await f.set({ itemId: item._id, date: null })).isError).toBe(true);
  });

  it("a saved date blocks only fresh Resparked in preview and web/core; Skip and Not a fit still work", async () => {
    const f = await fixture(); await f.capture("skip.date"); await f.capture("fit.date");
    const items = await f.claim();
    for (const item of items) expect((await f.set({ itemId: item._id })).isError).toBe(false);
    expect(await mark(f, items[0]._id, "resparked")).toMatchObject({ willRecord: 0 });
    await expect(f.web().mutation(api.respark.batches.markResparked, { itemId: items[0]._id })).rejects.toThrow(/contacted again/);
    expect(await mark(f, items[0]._id, "skipped")).toMatchObject({ willRecord: 1 });
    expect(await mark(f, items[1]._id, "not_a_fit")).toMatchObject({ willRecord: 1 });
  });

  it("invalidates an outstanding mark preview when a date arrives; a used token still replays", async () => {
    const f = await fixture(); await f.capture(); const [item] = await f.claim();
    const args = { marks: [{ itemId: item._id, result: "resparked" }], confirm: false };
    const preview = (await f.tool("magnus_mark_respark_items", args)).data as { confirmToken: string };
    await f.set({ itemId: item._id });
    expect((await f.tool("magnus_mark_respark_items", { ...args, confirm: true, confirmToken: preview.confirmToken })).isError).toBe(true);
    await f.set({ itemId: item._id, date: null });
    const commit = { ...args, confirm: true, confirmToken: preview.confirmToken };
    expect((await f.tool("magnus_mark_respark_items", commit)).isError).toBe(false);
    await f.set({ itemId: item._id });
    expect((await f.tool("magnus_mark_respark_items", commit)).isError).toBe(false);
  });

  it("redacts staff and amounts on every lead gen read, while admins see the original note", async () => {
    const f = await fixture(); const p = await f.capture(); const [item] = await f.claim();
    const note = "Alex Rivera agreed on $3,000, email alex@example.com";
    const set = await f.set({ itemId: item._id, note });
    expect((set.data as SetReply).contactAgain?.note?.text).toContain("[staff] agreed on [amount]");
    const mine = await f.web().query(api.leadGen.contactAgain.getContactAgain, { submissionId: p.submissionId });
    expect(mine.contactAgain?.note?.text).toContain("[staff] agreed on [amount]");
    expect(await f.web("user_admin").query(api.leadGen.contactAgain.getContactAgain, { leadId: p.leadId })).toMatchObject({ contactAgain: { note: { text: note } } });
    for (const [name, args] of [["magnus_respark_batch", {}], ["magnus_respark_person", { itemIds: [item._id] }]] as const) {
      const reply = await f.tool(name, args); expect(reply.isError).toBe(false);
      expect(JSON.stringify(reply.data)).toContain("[staff] agreed on [amount]");
      expect(JSON.stringify(reply.data)).not.toMatch(/Alex Rivera|\$3,000|alex@example.com/);
    }
    const batch = await f.web().query(api.respark.queries.getMyResparkBatch, {});
    expect(batch?.items[0].person?.contactAgain?.note?.text).toContain("[staff]");
    await f.t.run(async ctx => { for (let i = 0; i < 201; i++) await ctx.db.insert("teamMembers", { tenantId: f.tenantId, displayName: `Staff ${i}`, createdAt: NOW, updatedAt: NOW }); });
    expect((await f.web().query(api.leadGen.contactAgain.getContactAgain, { submissionId: p.submissionId })).contactAgain).toMatchObject({ note: null, withheldReason: "staff_roster_too_large" });
  });
});

describe("contact-again pool and transitions", () => {
  it("skips many future dates ahead of the first eligible person and charges every skipped candidate", async () => {
    const f = await fixture(); const ids = await poolPeople(f, 30, true);
    await f.t.run(ctx => ctx.db.patch("leads", ids.at(-1)!, { contactAgain: undefined }));
    expect((await f.claim()).map(item => item.leadId)).toEqual([ids.at(-1)]);
    const g = await fixture(); const many = await poolPeople(g, 1001, true);
    await g.t.run(ctx => ctx.db.patch("leads", many.at(-1)!, { contactAgain: undefined }));
    expect((await g.tool("magnus_claim_respark_batch", {})).data).toMatchObject({ batchId: null, size: 0 });
  }, 15_000);

  it("returns exact corrected counts at 512, unavailable at 513, and frees dates at equality without a write", async () => {
    const f = await fixture(); await poolPeople(f, 512, true);
    const counts = () => f.web().query(api.respark.queries.getResparkPoolCounts, {});
    expect(await counts()).toMatchObject({ isPartial: false, buckets: [{ bucket: 1, count: 0 }, { bucket: 2, count: 0 }, { bucket: 3, count: 0 }, { bucket: 4, count: 0 }, { bucket: 5, count: 0 }] });
    await poolPeople(f, 1, true);
    expect(await counts()).toMatchObject({ isPartial: true, buckets: null });
    const today = await f.tool("magnus_lead_gen_today", {}); expect(today.isError).toBe(false);
    expect(today.data).toMatchObject({ isPartial: true, counts: { pool: null } });
    vi.setSystemTime(AT - 1); expect((await counts()).buckets).toBeNull();
    vi.setSystemTime(AT); expect((await counts()).buckets?.[1].count).toBe(513);
    vi.setSystemTime(AT + DAY); expect((await counts()).buckets?.[1].count).toBe(513);
    expect((await f.claim()).length).toBeGreaterThan(0);
  });

  it("only subtracts bucket contributors and fails closed on the byte bound", async () => {
    const f = await fixture(); const ids = await poolPeople(f, 3, true);
    await f.t.run(async ctx => {
      const p = (await ctx.db.get("leads", ids[1]))!;
      await resparkTeamPool.replace(ctx, { namespace: f.tenantId, key: [f.teamId, "never_qualified", p.lastTouch!.occurredAt], id: p._id }, { namespace: f.tenantId, key: [f.teamId, "out", p.lastTouch!.occurredAt] });
      await ctx.db.patch("leads", p._id, { resparkGroup: "out" });
      await ctx.db.patch("leads", ids[2], { disposition: "do_not_contact" });
    });
    expect((await f.web().query(api.respark.queries.getResparkPoolCounts, {})).buckets?.[1].count).toBe(1);
    await f.t.run(ctx => ctx.db.patch("leads", ids[0], { fullName: "x".repeat(530_000) }));
    expect(await f.web().query(api.respark.queries.getResparkPoolCounts, {})).toMatchObject({ isPartial: true, buckets: null });
  });

  it("clears the date when enrollment sync converts a person", async () => {
    const f = await fixture(); const person = await f.capture();
    await f.set({ submissionId: person.submissionId });
    await f.t.run(async ctx => {
      const programId = await ctx.db.insert("tenantPrograms", { tenantId: f.tenantId, name: "Program", normalizedName: "program", createdAt: NOW, updatedAt: NOW, createdByUserId: f.adminId });
      const opportunityId = await ctx.db.insert("opportunities", { tenantId: f.tenantId, leadId: person.leadId, stage: "closed", outcome: "won", createdAt: NOW, updatedAt: NOW });
      await ctx.db.insert("paymentRecords", { tenantId: f.tenantId, opportunityId, attributedCloserId: f.closerId, recordedByUserId: f.adminId,
        amountMinor: 10000, currency: "USD", programId, programName: "Program", paymentType: "pif", status: "recorded", recordedAt: NOW, origin: "admin_side_deal" });
      await syncPersonEnrollments(ctx, { tenantId: f.tenantId, leadId: person.leadId, now: NOW, source: "admin", actorUserId: f.adminId });
    });
    expect(await f.lead(person.leadId)).toMatchObject({ status: "converted" });
    expect((await f.lead(person.leadId))?.contactAgain).toBeUndefined();
  });

  it("preserves the saved instant when tenant business-day settings change", async () => {
    const f = await fixture(); const person = await f.capture(); await f.set({ submissionId: person.submissionId });
    await f.t.run(ctx => ctx.db.patch("tenants", f.tenantId, { businessDay: { timeZone: "Europe/Madrid", dayStartHour: 5 } }));
    expect((await f.set({ submissionId: person.submissionId })).data).toMatchObject({ changed: false });
    expect((await f.lead(person.leadId))?.contactAgain).toEqual(f.saved());
  });

  it("clears dates in the central customer and do-not-contact transitions", async () => {
    const f = await fixture(); const customer = await f.capture("customer.date"); const dnc = await f.capture("dnc.date");
    await f.set({ submissionId: customer.submissionId }); await f.set({ submissionId: dnc.submissionId });
    await f.t.run(async ctx => {
      await advanceLeadLifecycle(ctx, customer.leadId, { stage: "customer", at: NOW, cause: "payment" });
      await adminSetDisposition(ctx, (await ctx.db.get("leads", dnc.leadId))!, "do_not_contact", { actorUserId: f.adminId, at: NOW, reason: "Requested" });
    });
    expect((await f.lead(customer.leadId))?.contactAgain).toBeUndefined();
    expect((await f.lead(dnc.leadId))?.contactAgain).toBeUndefined();
  });

  it.each([
    ["2026-11-02", null, "2026-11-02"], [null, "2026-11-03", "2026-11-03"],
    ["2026-11-04", "2026-11-03", "2026-11-04"], ["2026-11-02", "2026-11-03", "2026-11-03"],
    ["2026-11-03", "2026-11-03", "2026-11-03"], ["2026-09-02", "2026-09-03", "2026-09-03"],
  ])("merge carries the later entire object, target on ties: %s / %s", async (sourceDate, targetDate, expected) => {
    const f = await fixture(); const source = await f.capture("source.date"); const target = await f.capture("target.date");
    await f.t.run(async ctx => {
      if (sourceDate) await ctx.db.patch("leads", source.leadId, { contactAgain: f.saved(sourceDate, "Source") });
      if (targetDate) await ctx.db.patch("leads", target.leadId, { contactAgain: f.saved(targetDate, "Target") });
    });
    await f.web("user_admin").mutation(api.leads.merge.mergeLead, { sourceLeadId: source.leadId, targetLeadId: target.leadId });
    expect((await f.lead(source.leadId))?.contactAgain).toBeUndefined();
    expect((await f.lead(target.leadId))?.contactAgain).toEqual(f.saved(expected!, sourceDate === expected && sourceDate !== targetDate ? "Source" : "Target"));
  });

  it.each([{ disposition: "do_not_contact" as const }, { lifecycleStage: "customer" as const, status: "converted" as const }])("an ineligible merge survivor carries no date %j", async patch => {
    const f = await fixture(); const source = await f.capture("source.date"); const target = await f.capture("target.date");
    await f.t.run(async ctx => {
      await ctx.db.patch("leads", source.leadId, { contactAgain: f.saved() });
      await ctx.db.patch("leads", target.leadId, { ...patch, contactAgain: f.saved() });
    });
    await f.web("user_admin").mutation(api.leads.merge.mergeLead, { sourceLeadId: source.leadId, targetLeadId: target.leadId });
    expect((await f.lead(source.leadId))?.contactAgain).toBeUndefined();
    expect((await f.lead(target.leadId))?.contactAgain).toBeUndefined();
  });
});
