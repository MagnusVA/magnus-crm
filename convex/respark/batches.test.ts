import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { bookingHarness, testLeadGenTeam } from "../../tests/bookingHarness";
import { lifecycleProblems } from "../lib/leadLifecycle";
import { resparkResultsByWorker } from "../lib/respark/items";
import { DAY_MS } from "../lib/respark/settings";
import { recomputeResparkState, resparkStateProblems } from "../lib/respark/state";

// Respark batches, the hold and the actions (docs/plans/respark.md §4.5,
// §5.3), with the hold race and the tenant boundary.

afterEach(() => vi.useRealTimers());

type Harness = Awaited<ReturnType<typeof bookingHarness>>;
type Caller = Harness["admin"];

const NOW = Date.parse("2026-10-20T15:00:00Z");

async function addUser(
  h: Harness,
  workosUserId: string,
  role: "tenant_admin" | "lead_generator" | "closer",
  tenantId: Id<"tenants"> = h.tenantId,
  orgId = "org_test",
  // A lead generator's team; null for none.
  teamSlug: string | null = "team-a",
): Promise<Caller> {
  await h.t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      tenantId, workosUserId, email: `${workosUserId}@example.com`, role, isActive: true,
    });
    if (role === "lead_generator") {
      await ctx.db.insert("leadGenWorkers", {
        tenantId, userId, workosUserId, email: `${workosUserId}@example.com`, isActive: true,
        teamId: teamSlug ? await testLeadGenTeam(ctx, tenantId, teamSlug) : undefined, createdAt: 0, updatedAt: 0,
      });
    }
  });
  return h.t.withIdentity({ subject: workosUserId, org_id: orgId });
}

async function capture(caller: Caller, handle: string, at: number) {
  vi.setSystemTime(new Date(at));
  const result = await caller.mutation(api.leadGen.capture.submit, {
    source: "instagram", rawHandleOrProfileUrl: `@${handle}`, originKind: "follower",
  });
  return result.leadId!;
}

/** People captured `daysAgo` days before NOW, oldest handle first. */
async function pool(h: Harness, daysAgo: number[]) {
  for (const [index, days] of daysAgo.entries()) {
    await capture(h.admin, `pool.${index}`, NOW - days * DAY_MS);
  }
  vi.setSystemTime(new Date(NOW));
}

async function setBatchSize(h: Harness, batchSize: number, tenantId = h.tenantId) {
  await h.t.run((ctx) => ctx.db.patch("tenants", tenantId, { respark: { inactiveAfterDays: 90, batchSize } }));
}

async function batchItems(h: Harness, batchId: Id<"resparkBatches"> | null) {
  if (!batchId) return [];
  return await h.t.run((ctx) =>
    ctx.db.query("resparkBatchItems").withIndex("by_batchId_and_position", (q) => q.eq("batchId", batchId)).take(100),
  );
}

async function lead(h: Harness, leadId: Id<"leads">): Promise<Doc<"leads">> {
  return (await h.t.run((ctx) => ctx.db.get("leads", leadId)))!;
}

async function checks(h: Harness, leadId: Id<"leads">) {
  return await h.t.run(async (ctx) => {
    const person = (await ctx.db.get("leads", leadId))!;
    return [...(await lifecycleProblems(ctx, person)), ...(await resparkStateProblems(ctx, person))];
  });
}

describe("claimResparkBatch", () => {
  it("takes the pool oldest last touch first, up to the batch size, and gives the same batch back", async () => {
    vi.useFakeTimers();
    const h = await bookingHarness({ leadGenTeam: true });
    await pool(h, [100, 40, 60, 10]);
    await setBatchSize(h, 10);

    const first = await h.admin.mutation(api.respark.batches.claimResparkBatch, {});
    expect(first).toMatchObject({ resumed: false, size: 3 });
    const items = await batchItems(h, first.batchId);
    const times = await Promise.all(items.map(async (item) => (await lead(h, item.leadId)).lastTouch!.occurredAt));
    // The 10-day-old capture is under 30 days, so it isn't in the pool.
    expect(times).toEqual([NOW - 100 * DAY_MS, NOW - 60 * DAY_MS, NOW - 40 * DAY_MS]);
    expect(items.map((item) => item.bucket)).toEqual([2, 2, 2]);

    const again = await h.admin.mutation(api.respark.batches.claimResparkBatch, {});
    expect(again).toEqual({ ...first, resumed: true });
  });

  it("orders by last touch whatever the bucket, and labels each person with theirs", async () => {
    vi.useFakeTimers();
    const h = await bookingHarness({ leadGenTeam: true });
    await pool(h, [40, 50, 100]);
    const people = await h.t.run((ctx) => ctx.db.query("leads").take(3));
    const at = (days: number) => people.find((row) => row.lastTouch!.occurredAt === NOW - days * DAY_MS)!;
    const [qualified, neverQualified, hadCall] = [at(40), at(50), at(100)];
    // The newest reached Qualified and the oldest had a call, both with no
    // open deal; their groups follow from the stage.
    await h.t.run(async (ctx) => {
      for (const [person, stage] of [[qualified, "qualified"], [hadCall, "booked"]] as const) {
        await ctx.db.patch("leads", person._id, {
          lifecycleStage: stage,
          lifecycleStageEnteredAt: { ...person.lifecycleStageEnteredAt, qualified: person.lastTouch!.occurredAt, ...(stage === "booked" ? { booked: person.lastTouch!.occurredAt } : {}) },
        });
        await recomputeResparkState(ctx, (await ctx.db.get("leads", person._id))!);
      }
    });
    const { batchId } = await h.admin.mutation(api.respark.batches.claimResparkBatch, {});
    const items = await batchItems(h, batchId);
    expect(items.map((item) => [item.leadId, item.bucket])).toEqual([
      [hadCall._id, 3],
      [neverQualified._id, 2],
      [qualified._id, 1],
    ]);
  });

  it("breaks a tie on last touch by who was created first, across groups", async () => {
    vi.useFakeTimers();
    const h = await bookingHarness({ leadGenTeam: true });
    // Two captures at one time; the second, created later, reached Qualified.
    await pool(h, [45, 45, 60]);
    const people = await h.t.run((ctx) => ctx.db.query("leads").take(3));
    const oldest = people.find((row) => row.lastTouch!.occurredAt === NOW - 60 * DAY_MS)!;
    const sameTime = people.filter((row) => row.lastTouch!.occurredAt === NOW - 45 * DAY_MS)
      .sort((a, b) => a._creationTime - b._creationTime);
    await h.t.run(async (ctx) => {
      const later = sameTime[1];
      await ctx.db.patch("leads", later._id, {
        lifecycleStage: "qualified",
        lifecycleStageEnteredAt: { ...later.lifecycleStageEnteredAt, qualified: later.lastTouch!.occurredAt },
      });
      await recomputeResparkState(ctx, (await ctx.db.get("leads", later._id))!);
    });
    const { batchId } = await h.admin.mutation(api.respark.batches.claimResparkBatch, {});
    const items = await batchItems(h, batchId);
    expect(items.map((item) => [item.leadId, item.bucket])).toEqual([
      [oldest._id, 2],
      [sameTime[0]._id, 2],
      [sameTime[1]._id, 1],
    ]);
  });

    it("never gives two workers the same person, even claiming at once (the hold race)", async () => {
    vi.useFakeTimers();
    const h = await bookingHarness({ leadGenTeam: true });
    const second = await addUser(h, "user_lg", "lead_generator");
    await pool(h, [40, 41, 42, 43, 44]);
    await setBatchSize(h, 10);

    const [a, b] = await Promise.all([
      h.admin.mutation(api.respark.batches.claimResparkBatch, {}),
      second.mutation(api.respark.batches.claimResparkBatch, {}),
    ]);
    const leadsA = (await batchItems(h, a.batchId)).map((item) => item.leadId);
    const leadsB = (await batchItems(h, b.batchId)).map((item) => item.leadId);
    expect(leadsA.length + leadsB.length).toBe(5);
    expect(leadsA.filter((id) => leadsB.includes(id))).toEqual([]);
  });

  it("returns the unworked people to the pool when the business day ends", async () => {
    vi.useFakeTimers();
    const h = await bookingHarness({ leadGenTeam: true });
    const second = await addUser(h, "user_lg", "lead_generator");
    await pool(h, [40]);
    const a = await h.admin.mutation(api.respark.batches.claimResparkBatch, {});
    // An empty pool creates no batch.
    expect(await second.mutation(api.respark.batches.claimResparkBatch, {})).toEqual({ batchId: null, resumed: false, size: 0 });

    const [item] = await batchItems(h, a.batchId);
    vi.setSystemTime(new Date(item.heldUntil));
    await expect(
      h.admin.mutation(api.respark.batches.markResparked, { itemId: item._id }),
    ).rejects.toThrow("This batch ended with the business day.");
    const b = await second.mutation(api.respark.batches.claimResparkBatch, {});
    expect((await batchItems(h, b.batchId)).map((row) => row.leadId)).toEqual([item.leadId]);
  });

  it("keeps a skipped person from the same worker for the day, not from others", async () => {
    vi.useFakeTimers();
    const h = await bookingHarness({ leadGenTeam: true });
    const second = await addUser(h, "user_lg", "lead_generator");
    await pool(h, [40]);
    const a = await h.admin.mutation(api.respark.batches.claimResparkBatch, {});
    const [item] = await batchItems(h, a.batchId);
    await h.admin.mutation(api.respark.batches.skipResparkItem, { itemId: item._id });

    expect((await h.admin.mutation(api.respark.batches.claimResparkBatch, {})).size).toBe(0);
    // The worked batch counts as done, and the empty claim added none.
    expect((await h.admin.query(api.respark.queries.getMyResparkToday, {})).batchesDone).toBe(1);
    const b = await second.mutation(api.respark.batches.claimResparkBatch, {});
    expect((await batchItems(h, b.batchId)).map((row) => row.leadId)).toEqual([item.leadId]);
    // Skip writes nothing on the person.
    expect((await lead(h, item.leadId)).lastTouch?.eventType).toBe("lead.captured");
  });

  it("keeps a hold on a person merged into another, for the survivor", async () => {
    vi.useFakeTimers();
    const h = await bookingHarness({ leadGenTeam: true });
    const second = await addUser(h, "user_lg", "lead_generator");
    await pool(h, [40, 45]);
    await setBatchSize(h, 10);
    const all = await h.t.run((ctx) => ctx.db.query("leads").take(2));
    const held = all.find((row) => row.lastTouch!.occurredAt === NOW - 40 * DAY_MS)!;
    const survivor = all.find((row) => row._id !== held._id)!;
    // The admin holds both; skipping the survivor leaves its only hold on
    // the person merged into it.
    const first = await h.admin.mutation(api.respark.batches.claimResparkBatch, {});
    const items = await batchItems(h, first.batchId);
    const survivorItem = items.find((item) => item.leadId === survivor._id)!;
    await h.admin.mutation(api.respark.batches.skipResparkItem, { itemId: survivorItem._id });

    await h.admin.mutation(api.leads.merge.mergeLead, { sourceLeadId: held._id, targetLeadId: survivor._id });
    // The survivor carries the merged person's hold.
    expect((await second.mutation(api.respark.batches.claimResparkBatch, {})).size).toBe(0);
  });

  it("stays inside the caller's tenant", async () => {
    vi.useFakeTimers();
    const h = await bookingHarness({ leadGenTeam: true });
    await pool(h, [40]);
    const otherTenantId = await h.t.run((ctx) =>
      ctx.db.insert("tenants", {
        businessDayAppliedVersion: 0, companyName: "Other", contactEmail: "o@example.com",
        workosOrgId: "org_other", status: "active", inviteExpiresAt: 0, createdBy: "test",
      }),
    );
    const other = await addUser(h, "user_other", "tenant_admin", otherTenantId, "org_other");
    const mine = await h.admin.mutation(api.respark.batches.claimResparkBatch, {});
    const [item] = await batchItems(h, mine.batchId);

    expect((await other.mutation(api.respark.batches.claimResparkBatch, {})).size).toBe(0);
    for (const action of [
      api.respark.batches.markResparked,
      api.respark.batches.markNotAFit,
      api.respark.batches.skipResparkItem,
    ]) {
      await expect(other.mutation(action, { itemId: item._id })).rejects.toThrow("This person isn't in your batch.");
    }
  });

  it("stops a lead generator whose lead gen access was turned off during the day", async () => {
    vi.useFakeTimers();
    const h = await bookingHarness({ leadGenTeam: true });
    const lg = await addUser(h, "user_lg", "lead_generator");
    await pool(h, [40]);
    const { batchId } = await lg.mutation(api.respark.batches.claimResparkBatch, {});
    const [item] = await batchItems(h, batchId);
    await h.t.run((ctx) => ctx.db.patch("leadGenWorkers", item.workerId, { isActive: false }));
    for (const action of [
      api.respark.batches.markResparked,
      api.respark.batches.markNotAFit,
      api.respark.batches.skipResparkItem,
    ]) {
      await expect(lg.mutation(action, { itemId: item._id })).rejects.toThrow("not active");
    }
  });

    it("is only for roles with lead-gen:respark", async () => {
    vi.useFakeTimers();
    const h = await bookingHarness({ leadGenTeam: true });
    await expect(h.closer.mutation(api.respark.batches.claimResparkBatch, {})).rejects.toThrow();
  });
});

describe("team pools", () => {
  it("gives each lead generator only their team's people, a person shared by teams going to the first capture's", async () => {
    vi.useFakeTimers();
    const h = await bookingHarness({ leadGenTeam: true });
    const teamB = await addUser(h, "gen_b", "lead_generator", h.tenantId, "org_test", "team-b");
    await setBatchSize(h, 10);
    const teamAOnly = await capture(h.admin, "team.a.only", NOW - 40 * DAY_MS);
    const teamBOnly = await capture(teamB, "team.b.only", NOW - 50 * DAY_MS);
    // Team B captured them first, so they're Team B's after Team A's capture too.
    const both = await capture(teamB, "both.teams", NOW - 70 * DAY_MS);
    expect(await capture(h.admin, "both.teams", NOW - 45 * DAY_MS)).toBe(both);
    vi.setSystemTime(new Date(NOW));

    const mine = await h.admin.mutation(api.respark.batches.claimResparkBatch, {});
    expect((await batchItems(h, mine.batchId)).map((item) => item.leadId)).toEqual([teamAOnly]);
    const theirs = await teamB.mutation(api.respark.batches.claimResparkBatch, {});
    expect((await batchItems(h, theirs.batchId)).map((item) => item.leadId)).toEqual([teamBOnly, both]);
    for (const leadId of [teamAOnly, teamBOnly, both]) expect(await checks(h, leadId)).toEqual([]);

    const counts = async (caller: Caller) =>
      (await caller.query(api.respark.queries.getResparkPoolCounts, {})).buckets.map((bucket) => bucket.count);
    expect(await counts(h.admin)).toEqual([0, 1, 0, 0, 0]);
    expect(await counts(teamB)).toEqual([0, 2, 0, 0, 0]);
  });

  it("gives a lead generator with no team an empty pool, and says why", async () => {
    vi.useFakeTimers();
    const h = await bookingHarness({ leadGenTeam: true });
    await pool(h, [40]);
    const noTeam = await addUser(h, "gen_none", "lead_generator", h.tenantId, "org_test", null);
    expect(await noTeam.mutation(api.respark.batches.claimResparkBatch, {}))
      .toEqual({ batchId: null, resumed: false, size: 0, noTeam: true });
    const counts = await noTeam.query(api.respark.queries.getResparkPoolCounts, {});
    expect(counts.noTeam).toBe(true);
    expect(counts.buckets.map((bucket) => bucket.count)).toEqual([0, 0, 0, 0, 0]);
    expect((await h.admin.query(api.respark.queries.getResparkPoolCounts, {})).noTeam).toBe(false);
  });

  it("skips a capture by a specialist with no team when it picks the team", async () => {
    vi.useFakeTimers();
    const h = await bookingHarness({ leadGenTeam: true });
    const noTeam = await addUser(h, "gen_none", "lead_generator", h.tenantId, "org_test", null);
    const person = await capture(noTeam, "no.team.first", NOW - 70 * DAY_MS);
    expect((await lead(h, person)).resparkTeamId).toBeUndefined();
    await capture(h.admin, "no.team.first", NOW - 45 * DAY_MS);
    vi.setSystemTime(new Date(NOW));
    expect((await lead(h, person)).resparkTeamId).toBe(h.leadGenTeamId);
    expect(await checks(h, person)).toEqual([]);
    const mine = await h.admin.mutation(api.respark.batches.claimResparkBatch, {});
    expect((await batchItems(h, mine.batchId)).map((item) => item.leadId)).toEqual([person]);
  });

  it("gives a merged person the team of the earliest capture of either", async () => {
    vi.useFakeTimers();
    const h = await bookingHarness({ leadGenTeam: true });
    const teamB = await addUser(h, "gen_b", "lead_generator", h.tenantId, "org_test", "team-b");
    const target = await capture(h.admin, "merge.target", NOW - 40 * DAY_MS);
    const source = await capture(teamB, "merge.source", NOW - 60 * DAY_MS);
    vi.setSystemTime(new Date(NOW));
    const teamBId = (await lead(h, source)).resparkTeamId;
    expect(teamBId).toBeDefined();
    expect((await lead(h, target)).resparkTeamId).toBe(h.leadGenTeamId);

    await h.admin.mutation(api.leads.merge.mergeLead, { sourceLeadId: source, targetLeadId: target });
    expect((await lead(h, target)).resparkTeamId).toBe(teamBId);
    expect((await lead(h, source)).resparkTeamId).toBeUndefined();
    expect(await checks(h, target)).toEqual([]);
    const theirs = await teamB.mutation(api.respark.batches.claimResparkBatch, {});
    expect((await batchItems(h, theirs.batchId)).map((item) => item.leadId)).toEqual([target]);
    expect((await h.admin.mutation(api.respark.batches.claimResparkBatch, {})).size).toBe(0);
  });
});

describe("the actions", () => {
  async function heldPerson(h: Harness, daysAgo = 40) {
    await pool(h, [daysAgo]);
    const { batchId } = await h.admin.mutation(api.respark.batches.claimResparkBatch, {});
    const [item] = await batchItems(h, batchId);
    return item;
  }

  it("Resparked: a touch, In conversation kept, a not a fit reopened, the item worked", async () => {
    vi.useFakeTimers();
    const h = await bookingHarness({ leadGenTeam: true });
    const item = await heldPerson(h);
    // A respark reopens any not a fit, an admin's included (plan §4.7).
    await h.admin.mutation(api.leads.lifecycleAdmin.setDisposition, {
      leadId: item.leadId, disposition: "not_a_fit", reason: "Test",
    });
    expect((await lead(h, item.leadId)).resparkGroup).toBe("not_a_fit");
    await h.admin.mutation(api.respark.batches.markResparked, { itemId: item._id });

    const person = await lead(h, item.leadId);
    expect(person).toMatchObject({
      lifecycleStage: "in_conversation",
      disposition: "open",
      dispositionSource: "respark",
      dispositionSetAt: NOW,
    });
    expect(person.lastTouch).toMatchObject({ eventType: "lead.resparked", occurredAt: NOW });
    expect(person.latestTouch).toMatchObject({ eventType: "lead.resparked", channel: "lead_gen" });
    // Touched today, so out of every bucket for 30 days.
    expect(person.resparkGroup).toBe("never_qualified");
    const worked = (await batchItems(h, item.batchId))[0];
    expect(worked).toMatchObject({ result: "resparked", workedAt: NOW, eventId: person.lastTouch!.eventId });
    expect(await checks(h, item.leadId)).toEqual([]);
    const resparks = await h.t.run((ctx) =>
      resparkResultsByWorker.count(ctx, { namespace: h.tenantId, bounds: { prefix: [item.workerId, "resparked"] } }),
    );
    expect(resparks).toBe(1);
    await expect(
      h.admin.mutation(api.respark.batches.skipResparkItem, { itemId: item._id }),
    ).rejects.toThrow("already worked");
  });

  it("Not a fit: a touch and the disposition, and bucket 5 after 30 days", async () => {
    vi.useFakeTimers();
    const h = await bookingHarness({ leadGenTeam: true });
    const item = await heldPerson(h);
    await h.admin.mutation(api.respark.batches.markNotAFit, { itemId: item._id });
    const person = await lead(h, item.leadId);
    expect(person).toMatchObject({
      disposition: "not_a_fit",
      dispositionSource: "respark",
      resparkGroup: "not_a_fit",
      lifecycleStage: "in_conversation",
    });
    expect(person.lastTouch).toMatchObject({ eventType: "lead.marked_not_a_fit", occurredAt: NOW });
    // Not a channel touch: it brings no one back.
    expect(person.latestTouch?.eventType).toBe("lead.captured");
    expect(await checks(h, item.leadId)).toEqual([]);

    vi.setSystemTime(new Date(NOW + 31 * DAY_MS));
    const later = await h.admin.mutation(api.respark.batches.claimResparkBatch, {});
    expect((await batchItems(h, later.batchId)).map((row) => [row.leadId, row.bucket])).toEqual([[item.leadId, 5]]);
  });

  it("a second Not a fit moves the decision's time, so older evidence doesn't reopen it", async () => {
    vi.useFakeTimers();
    const h = await bookingHarness({ leadGenTeam: true });
    const item = await heldPerson(h);
    await h.admin.mutation(api.respark.batches.markNotAFit, { itemId: item._id });
    const later = NOW + 31 * DAY_MS;
    vi.setSystemTime(new Date(later));
    const { batchId } = await h.admin.mutation(api.respark.batches.claimResparkBatch, {});
    const [again] = await batchItems(h, batchId);
    expect(again.leadId).toBe(item.leadId);
    await h.admin.mutation(api.respark.batches.markNotAFit, { itemId: again._id });
    expect(await lead(h, item.leadId)).toMatchObject({ disposition: "not_a_fit", dispositionSetAt: later });
  });

  it("derives the stage from Resparked items only, however many other items a person has", async () => {
    vi.useFakeTimers();
    const h = await bookingHarness({ leadGenTeam: true });
    const item = await heldPerson(h);
    await h.admin.mutation(api.respark.batches.markResparked, { itemId: item._id });
    await h.t.run(async (ctx) => {
      const { _id, _creationTime, ...fields } = (await ctx.db.get("resparkBatchItems", item._id))!;
      for (let i = 0; i < 210; i += 1) {
        await ctx.db.insert("resparkBatchItems", { ...fields, result: "skipped", eventId: undefined, heldUntil: fields.heldUntil - (i + 1) * DAY_MS });
      }
    });
    expect(await checks(h, item.leadId)).toEqual([]);
  });

  it("Not a fit leaves a disposition an admin set", async () => {
    vi.useFakeTimers();
    const h = await bookingHarness({ leadGenTeam: true });
    const item = await heldPerson(h);
    await h.admin.mutation(api.leads.lifecycleAdmin.setDisposition, {
      leadId: item.leadId, disposition: "nurture", reason: "Test",
    });
    await h.admin.mutation(api.respark.batches.markNotAFit, { itemId: item._id });
    const person = await lead(h, item.leadId);
    expect(person).toMatchObject({ disposition: "nurture", dispositionSource: "admin" });
    expect(person.lastTouch?.eventType).toBe("lead.marked_not_a_fit");
    expect((await batchItems(h, item.batchId))[0].result).toBe("not_a_fit");
  });

  it("rejects Resparked and Not a fit for someone who left the pool during the hold, and allows Skip", async () => {
    vi.useFakeTimers();
    const h = await bookingHarness({ leadGenTeam: true });
    const item = await heldPerson(h);
    await h.admin.mutation(api.leads.lifecycleAdmin.setDisposition, {
      leadId: item.leadId, disposition: "do_not_contact", reason: "Asked us to stop",
    });
    for (const action of [api.respark.batches.markResparked, api.respark.batches.markNotAFit]) {
      await expect(h.admin.mutation(action, { itemId: item._id })).rejects.toThrow("do not contact");
    }
    await h.admin.mutation(api.respark.batches.skipResparkItem, { itemId: item._id });
    expect((await batchItems(h, item.batchId))[0].result).toBe("skipped");
  });

  it("a qualification reopens a respark not a fit; a capture doesn't", async () => {
    vi.useFakeTimers();
    const h = await bookingHarness({ leadGenTeam: true });
    const item = await heldPerson(h);
    await h.admin.mutation(api.respark.batches.markNotAFit, { itemId: item._id });
    const handle = (await lead(h, item.leadId)).socialHandles![0].handle;

    await capture(h.admin, handle, NOW + DAY_MS);
    expect((await lead(h, item.leadId)).disposition).toBe("not_a_fit");

    vi.setSystemTime(new Date(NOW + 2 * DAY_MS));
    const installationId = await h.t.run((ctx) =>
      ctx.db.insert("slackInstallations", {
        tenantId: h.tenantId, teamId: "T1", teamName: "Team", isEnterpriseInstall: false,
        appId: "A1", botUserId: "B1", botAccessToken: "xoxb", scopes: [], notifyChannelId: "C1",
        notifyChannelName: "qualified", installedByWorkosUserId: "user_slack", installedAt: 0,
        tokenExpiresAt: 0, refreshToken: "r", status: "active",
      }),
    );
    await h.t.mutation(internal.slack.createQualifiedLead.create, {
      tenantId: h.tenantId, installationId, fullName: "Respark Lead", handle, country: "Honduras",
      leadType: "pt", qualifiedBy: { slackUserId: "U1", slackTeamId: "T1", submittedAt: NOW + 2 * DAY_MS },
    });
    const person = await lead(h, item.leadId);
    expect(person).toMatchObject({ disposition: "open", dispositionSource: "system", lifecycleStage: "qualified" });
  });
});
