import { afterEach, describe, expect, it, vi } from "vitest";
import { bookingHarness } from "../../tests/bookingHarness";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { DAY_MS } from "../lib/respark/settings";
import { resparkPool } from "../lib/respark/state";
import type { ResparkGroup } from "../lib/respark/validators";

const NOW = Date.parse("2026-10-20T15:00:00Z");
type Harness = Awaited<ReturnType<typeof bookingHarness>>;
afterEach(() => vi.useRealTimers());

async function capture(h: Harness, handle: string, at = NOW - 40 * DAY_MS) {
  vi.setSystemTime(at);
  const result = await h.admin.mutation(api.leadGen.capture.submit, {
    source: "instagram", rawHandleOrProfileUrl: `@${handle}`, originKind: "follower",
  });
  vi.setSystemTime(NOW);
  return result.leadId!;
}
async function held(h: Harness) {
  const leadId = await capture(h, "respark.panel");
  const { batchId } = await h.admin.mutation(api.respark.batches.claimResparkBatch, {});
  const [item] = await h.t.run((ctx) => ctx.db.query("resparkBatchItems")
    .withIndex("by_batchId_and_position", (q) => q.eq("batchId", batchId)).take(1));
  return { leadId, item, batchId };
}
async function otherUser(h: Harness, foreignTenant = false) {
  const tenantId = await h.t.run(async (ctx) => {
    const tenantId = foreignTenant ? await ctx.db.insert("tenants", {
      businessDayAppliedVersion: 0, companyName: "Other", contactEmail: "other@example.com",
      workosOrgId: "org_other", status: "active", inviteExpiresAt: 0, createdBy: "test",
    }) : h.tenantId;
    await ctx.db.insert("users", { tenantId, workosUserId: "user_other", email: "other@example.com",
      isActive: true, role: "tenant_admin" });
    return tenantId;
  });
  return { tenantId, caller: h.t.withIdentity({ subject: "user_other", org_id: foreignTenant ? "org_other" : "org_test" }) };
}

async function panelFacts(h: Harness, leadId: Id<"leads">, userId: Id<"users">) {
  return await h.t.run(async (ctx) => {
    const person = (await ctx.db.get("leads", leadId))!;
    await ctx.db.patch("leads", leadId, { fullName: "Private Person", phone: "+50499999912", email: "alice@gmail.com" });
    await ctx.db.insert("leadNotes", { tenantId: h.tenantId, leadId, authorKind: "user", userId,
      content: "Opener: email alice@gmail.com or call +50499999912", createdAt: NOW - DAY_MS });
    await ctx.db.insert("leadNotes", { tenantId: h.tenantId, leadId, authorKind: "user", userId,
      content: "Deleted secret", createdAt: NOW, deletedAt: NOW });
    const dealId = await ctx.db.insert("opportunities", { tenantId: h.tenantId, leadId,
      stage: "closed", outcome: "lost", lostReason: "no_show", createdAt: NOW - 10 * DAY_MS, updatedAt: NOW });
    const meetingId = await ctx.db.insert("meetings", { tenantId: h.tenantId, opportunityId: dealId,
      assignedCloserId: userId, calendlyEventUri: "event/panel", calendlyInviteeUri: "invitee/panel",
      scheduledAt: NOW - 9 * DAY_MS, durationMinutes: 30, status: "no_show", createdAt: NOW - 10 * DAY_MS });
    await ctx.db.insert("meetingFormResponses", { tenantId: h.tenantId, leadId, opportunityId: dealId,
      meetingId, fieldKey: "goal", questionLabelSnapshot: "Goal", answerText: "Grow my business. alice@gmail.com +50499999912",
      capturedAt: NOW - 10 * DAY_MS });
    const rawEventId = await ctx.db.insert("rawWebhookEvents", { tenantId: h.tenantId,
      calendlyEventUri: "event/panel", eventType: "invitee.created", processed: true, receivedAt: NOW,
      payload: JSON.stringify({ payload: { timezone: "Europe/Madrid", email: "alice@gmail.com" } }) });
    await ctx.db.insert("webhookDeliveries", { tenantId: h.tenantId, key: "panel", eventType: "invitee.created",
      inviteeUri: "invitee/panel", rawEventId, occurredAt: NOW, receivedAt: NOW, generation: 1,
      status: "applied", meetingId, opportunityId: dealId, leadId });
    for (const [index, eventType] of ["lead.portal_note_added", "lead.slack_qualified", "meeting.created", "payment.recorded"].entries()) {
      await ctx.db.insert("domainEvents", { tenantId: h.tenantId, leadId, entityType: eventType.startsWith("payment") ? "payment" : "lead",
        entityId: leadId, eventType, occurredAt: NOW - (4 - index) * 1000, source: "pipeline" });
    }
    await ctx.db.patch("leads", leadId, { lifecycleStage: "booked", resparkGroup: "had_call",
      lifecycleStageEnteredAt: { ...person.lifecycleStageEnteredAt, qualified: NOW - 11 * DAY_MS } });
    return { dealId, meetingId };
  });
}

describe("Respark queries", () => {
  it("gates every query by lead-gen:respark, including anonymous callers", async () => {
    vi.useFakeTimers();
    const h = await bookingHarness();
    const { item } = await held(h);
    for (const caller of [h.closer, h.t]) {
      await expect(caller.query(api.respark.queries.getMyResparkBatch, {})).rejects.toThrow();
      await expect(caller.query(api.respark.queries.getResparkPoolCounts, {})).rejects.toThrow();
      await expect(caller.query(api.respark.queries.getMyResparkToday, {})).rejects.toThrow();
      await expect(caller.query(api.respark.queries.getResparkPersonPanel, { itemId: item._id })).rejects.toThrow();
    }
  });

  it("keeps all four queries inside the caller's tenant", async () => {
    vi.useFakeTimers();
    const h = await bookingHarness();
    const { item } = await held(h);
    await h.admin.mutation(api.respark.batches.markResparked, { itemId: item._id });
    const other = await otherUser(h, true);
    expect(await other.caller.query(api.respark.queries.getMyResparkBatch, {})).toBeNull();
    expect((await other.caller.query(api.respark.queries.getResparkPoolCounts, {})).buckets.map((b) => b.count)).toEqual([0, 0, 0, 0, 0]);
    expect(await other.caller.query(api.respark.queries.getMyResparkToday, {})).toMatchObject({ batchesStarted: 0, resparks: 0, notAFits: 0 });
    expect(await other.caller.query(api.respark.queries.getResparkPersonPanel, { itemId: item._id })).toBeNull();
  });

  it("returns null for another user's item and at batch expiry, including worked items", async () => {
    vi.useFakeTimers();
    const h = await bookingHarness();
    const { item, batchId } = await held(h);
    const other = await otherUser(h);
    expect(await other.caller.query(api.respark.queries.getResparkPersonPanel, { itemId: item._id })).toBeNull();
    expect(await other.caller.query(api.respark.queries.getMyResparkBatch, {})).toBeNull();
    await h.admin.mutation(api.respark.batches.markResparked, { itemId: item._id });
    expect(await h.admin.query(api.respark.queries.getResparkPersonPanel, { itemId: item._id })).not.toBeNull();
    expect((await h.admin.query(api.respark.queries.getMyResparkBatch, {}))?.items[0].result).toBe("resparked");
    // The batch itself is authoritative, even if an item's copied expiry differs.
    await h.t.run((ctx) => ctx.db.patch("resparkBatches", batchId, { heldUntil: NOW }));
    expect(await h.admin.query(api.respark.queries.getResparkPersonPanel, { itemId: item._id })).toBeNull();
    expect(await h.admin.query(api.respark.queries.getMyResparkBatch, {})).toBeNull();
  });

  it("masks identity, notes and booking answers on the server; omits payment events and credit", async () => {
    vi.useFakeTimers();
    const h = await bookingHarness();
    const { item, leadId } = await held(h);
    const facts = await panelFacts(h, leadId, item.userId);
    const panel = (await h.admin.query(api.respark.queries.getResparkPersonPanel, { itemId: item._id }))!;
    expect(panel.identity).toEqual({ name: "Private Person", email: "a•••@gmail.com", phone: "+504 ••• ••12" });
    expect(panel.timeZone).toBe("Europe/Madrid");
    expect(panel.calls[0]).toMatchObject({ meetingId: facts.meetingId, bookingAnswers: [{ question: "Goal" }] });
    expect(panel.deals[0]).toMatchObject({ opportunityId: facts.dealId, stage: "closed", outcome: "lost", lostReason: "no_show" });
    expect(panel.timeline.some((event) => event.eventType === "lead.slack_qualified")).toBe(true);
    expect(panel.timeline.some((event) => event.eventType.startsWith("payment."))).toBe(false);
    expect(panel.notes).toHaveLength(1);
    expect(panel.resparkHistory[0].itemId).toBe(item._id);
    const json = JSON.stringify(panel);
    for (const secret of ["alice@gmail.com", "+50499999912", "Deleted secret", "payment.recorded", "/workspace/", "dealAttributions"]) {
      expect(json).not.toContain(secret);
    }
    expect(panel).not.toHaveProperty("credits");
    expect(panel).not.toHaveProperty("payments");
    expect(panel.capped).toBe(false);
  });

  it("returns ordered cards, capture and qualification facts, latest deal, last touches, and the action's blocked reason", async () => {
    vi.useFakeTimers();
    const h = await bookingHarness();
    const { item, leadId } = await held(h);
    await panelFacts(h, leadId, item.userId);
    const batch = (await h.admin.query(api.respark.queries.getMyResparkBatch, {}))!;
    expect(batch.items[0]).toMatchObject({ itemId: item._id, position: 0, bucket: 2, result: null, workedAt: null,
      person: { handle: "respark.panel", capturedAt: NOW - 40 * DAY_MS, capturedBy: "admin@example.com",
        qualifiedAt: NOW - 11 * DAY_MS, timeZone: null, newestDeal: { lostReason: "no_show" } },
      blockedReason: null });
    expect(batch.items[0].person!.lastTouches.map((event) => event.eventType)).toEqual(["payment.recorded", "meeting.created", "lead.slack_qualified"]);
    // A hand-written loss reason can hold contact details; the card masks them.
    await h.t.run(async (ctx) => {
      const deal = (await ctx.db.query("opportunities").withIndex("by_tenantId_and_leadId", (q) =>
        q.eq("tenantId", h.tenantId).eq("leadId", leadId)).first())!;
      await ctx.db.patch("opportunities", deal._id, { lostReason: "Asked us to use alice@gmail.com or +50499999912" });
    });
    const masked = JSON.stringify(await h.admin.query(api.respark.queries.getMyResparkBatch, {}));
    expect(masked).not.toContain("alice@gmail.com");
    expect(masked).not.toContain("99999912");
    await h.admin.mutation(api.leads.lifecycleAdmin.setDisposition, { leadId, disposition: "do_not_contact", reason: "Stop" });
    const blocked = (await h.admin.query(api.respark.queries.getMyResparkBatch, {}))!.items[0].blockedReason;
    expect(blocked).toBe("This person is marked do not contact.");
    await expect(h.admin.mutation(api.respark.batches.markResparked, { itemId: item._id })).rejects.toThrow(blocked!);
  });

  it("counts the same five buckets as a claim, including exclusive and inclusive boundaries", async () => {
    vi.useFakeTimers();
    const h = await bookingHarness();
    await h.t.run((ctx) => ctx.db.patch("tenants", h.tenantId, { respark: { batchSize: 100, inactiveAfterDays: 90 } }));
    const cases: [ResparkGroup, number, number | null][] = [
      ["qualified", 30, 1], ["never_qualified", 30, 2], ["had_call", 90, 3],
      ["had_call", 89, 4], ["had_call", 30, 4], ["not_a_fit", 30, 5],
      ["never_qualified", 29, null], ["out", 100, null],
    ];
    for (const [index, [group, days]] of cases.entries()) {
      const leadId = await capture(h, `bucket.${index}`, NOW - days * DAY_MS);
      await h.t.run(async (ctx) => {
        const lead = (await ctx.db.get("leads", leadId))!;
        await resparkPool.replaceOrInsert(ctx, { namespace: h.tenantId, id: leadId,
          key: [lead.resparkGroup!, lead.lastTouch!.occurredAt] }, { namespace: h.tenantId, key: [group, lead.lastTouch!.occurredAt] });
        await ctx.db.patch("leads", leadId, { resparkGroup: group });
      });
    }
    const counts = await h.admin.query(api.respark.queries.getResparkPoolCounts, {});
    expect(counts.buckets.map((bucket) => bucket.count)).toEqual([1, 1, 1, 2, 1]);
    const { batchId } = await h.admin.mutation(api.respark.batches.claimResparkBatch, {});
    const batch = (await h.admin.query(api.respark.queries.getMyResparkBatch, {}))!;
    expect(batch.batchId).toBe(batchId);
    expect(batch.heldUntil).toBe(counts.heldUntil);
    expect(batch.size).toBe(6);
    expect(batch.items.map((item) => item.position)).toEqual([0, 1, 2, 3, 4, 5]);
    for (const bucket of counts.buckets) expect(batch.items.filter((item) => item.bucket === bucket.bucket)).toHaveLength(bucket.count);
  });

  it("serves a maximum-size batch within Convex transaction limits", async () => {
    vi.useFakeTimers();
    const h = await bookingHarness({ transactionLimits: true });
    await h.t.run((ctx) => ctx.db.patch("tenants", h.tenantId, { respark: { batchSize: 100, inactiveAfterDays: 90 } }));
    for (let index = 0; index < 100; index += 1) await capture(h, `maximum.${index}`);
    await h.admin.mutation(api.respark.batches.claimResparkBatch, {});
    const batch = (await h.admin.query(api.respark.queries.getMyResparkBatch, {}))!;
    expect(batch.items).toHaveLength(100);
    expect(batch.items.every((item) => item.person?.lastTouches.length === 1)).toBe(true);
    expect(batch.capped).toBe(false);
  }, 30_000);

  it("admits a lead generator with their own held batch", async () => {
    vi.useFakeTimers();
    const h = await bookingHarness();
    await capture(h, "generator.person");
    await h.t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { tenantId: h.tenantId, workosUserId: "generator",
        email: "generator@example.com", role: "lead_generator", isActive: true });
      await ctx.db.insert("leadGenWorkers", { tenantId: h.tenantId, userId, workosUserId: "generator",
        email: "generator@example.com", isActive: true, createdAt: NOW, updatedAt: NOW });
    });
    const caller = h.t.withIdentity({ subject: "generator", org_id: "org_test" });
    const { batchId } = await caller.mutation(api.respark.batches.claimResparkBatch, {});
    const batch = (await caller.query(api.respark.queries.getMyResparkBatch, {}))!;
    expect(batch.batchId).toBe(batchId);
    expect((await caller.query(api.respark.queries.getResparkPoolCounts, {})).buckets[1].count).toBe(1);
    expect((await caller.query(api.respark.queries.getMyResparkToday, {})).batchesStarted).toBe(1);
    expect(await caller.query(api.respark.queries.getResparkPersonPanel, { itemId: batch.items[0].itemId })).not.toBeNull();
  });

  it("marks a capped timeline explicitly and still returns notes and deals", async () => {
    vi.useFakeTimers();
    const h = await bookingHarness();
    const { item, leadId } = await held(h);
    await panelFacts(h, leadId, item.userId);
    await h.t.run(async (ctx) => {
      for (let index = 0; index < 501; index += 1) await ctx.db.insert("domainEvents", {
        tenantId: h.tenantId, leadId, entityType: "lead", entityId: leadId,
        eventType: "lead.portal_note_added", source: "pipeline", occurredAt: NOW + index,
      });
    });
    const panel = (await h.admin.query(api.respark.queries.getResparkPersonPanel, { itemId: item._id }))!;
    expect(panel.capped).toBe(true);
    expect(panel.timeline).toHaveLength(500);
    expect(panel.notes).toHaveLength(1);
    expect(panel.deals).toHaveLength(1);
  });

  it("uses the tenant's business day for started batches and worked results", async () => {
    vi.useFakeTimers();
    const h = await bookingHarness();
    await h.t.run((ctx) => ctx.db.patch("tenants", h.tenantId, { businessDay: { timeZone: "UTC", dayStartHour: 6 } }));
    await capture(h, "today.1");
    await capture(h, "today.2");
    const { batchId } = await h.admin.mutation(api.respark.batches.claimResparkBatch, {});
    const items = await h.t.run((ctx) => ctx.db.query("resparkBatchItems")
      .withIndex("by_batchId_and_position", (q) => q.eq("batchId", batchId)).take(100));
    await h.admin.mutation(api.respark.batches.markResparked, { itemId: items[0]._id });
    await h.admin.mutation(api.respark.batches.markNotAFit, { itemId: items[1]._id });
    expect(await h.admin.query(api.respark.queries.getMyResparkToday, {})).toEqual({
      batchesStarted: 1, resparks: 1, notAFits: 1,
      start: Date.parse("2026-10-20T06:00:00Z"), end: Date.parse("2026-10-21T06:00:00Z"),
    });
    vi.setSystemTime(Date.parse("2026-10-21T06:00:00Z"));
    expect(await h.admin.query(api.respark.queries.getMyResparkToday, {})).toMatchObject({ batchesStarted: 0, resparks: 0, notAFits: 0 });
  });
});
