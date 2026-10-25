import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { bookingHarness } from "../../tests/bookingHarness";
import { lifecycleProblems } from "../lib/leadLifecycle";
import { resparkResultsByWorker } from "../lib/respark/items";
import { DAY_MS } from "../lib/respark/settings";
import { resparkStateProblems } from "../lib/respark/state";

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
): Promise<Caller> {
  await h.t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      tenantId, workosUserId, email: `${workosUserId}@example.com`, role, isActive: true,
    });
    if (role === "lead_generator") {
      await ctx.db.insert("leadGenWorkers", {
        tenantId, userId, workosUserId, email: `${workosUserId}@example.com`, isActive: true,
        createdAt: 0, updatedAt: 0,
      });
    }
  });
  return h.t.withIdentity({ subject: workosUserId, org_id: orgId });
}

async function capture(caller: Caller, handle: string, at: number) {
  vi.setSystemTime(new Date(at));
  await caller.mutation(api.leadGen.capture.submit, {
    source: "instagram", rawHandleOrProfileUrl: `@${handle}`, originKind: "follower",
  });
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

async function batchItems(h: Harness, batchId: Id<"resparkBatches">) {
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
  it("takes the pool newest first, up to the batch size, and gives the same batch back", async () => {
    vi.useFakeTimers();
    const h = await bookingHarness();
    await pool(h, [100, 40, 60, 10]);
    await setBatchSize(h, 10);

    const first = await h.admin.mutation(api.respark.batches.claimResparkBatch, {});
    expect(first).toMatchObject({ resumed: false, size: 3 });
    const items = await batchItems(h, first.batchId);
    const times = await Promise.all(items.map(async (item) => (await lead(h, item.leadId)).lastTouch!.occurredAt));
    // The 10-day-old capture is under 30 days, so it isn't in the pool.
    expect(times).toEqual([NOW - 40 * DAY_MS, NOW - 60 * DAY_MS, NOW - 100 * DAY_MS]);
    expect(items.map((item) => item.bucket)).toEqual([2, 2, 2]);

    const again = await h.admin.mutation(api.respark.batches.claimResparkBatch, {});
    expect(again).toEqual({ ...first, resumed: true });
  });

  it("walks the buckets in order", async () => {
    vi.useFakeTimers();
    const h = await bookingHarness();
    await pool(h, [40, 50]);
    const [neverQualified, qualified] = await h.t.run((ctx) => ctx.db.query("leads").take(2));
    // The second person reached Qualified, with no open deal.
    await h.t.run(async (ctx) => {
      await ctx.db.patch("leads", qualified._id, {
        lifecycleStage: "qualified",
        lifecycleStageEnteredAt: { ...qualified.lifecycleStageEnteredAt, qualified: NOW - 50 * DAY_MS },
        resparkGroup: "qualified",
      });
    });
    const { batchId } = await h.admin.mutation(api.respark.batches.claimResparkBatch, {});
    const items = await batchItems(h, batchId);
    expect(items.map((item) => [item.leadId, item.bucket])).toEqual([[qualified._id, 1], [neverQualified._id, 2]]);
  });

  it("never gives two workers the same person, even claiming at once (the hold race)", async () => {
    vi.useFakeTimers();
    const h = await bookingHarness();
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
    const h = await bookingHarness();
    const second = await addUser(h, "user_lg", "lead_generator");
    await pool(h, [40]);
    const a = await h.admin.mutation(api.respark.batches.claimResparkBatch, {});
    expect((await second.mutation(api.respark.batches.claimResparkBatch, {})).size).toBe(0);

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
    const h = await bookingHarness();
    const second = await addUser(h, "user_lg", "lead_generator");
    await pool(h, [40]);
    const a = await h.admin.mutation(api.respark.batches.claimResparkBatch, {});
    const [item] = await batchItems(h, a.batchId);
    await h.admin.mutation(api.respark.batches.skipResparkItem, { itemId: item._id });

    expect((await h.admin.mutation(api.respark.batches.claimResparkBatch, {})).size).toBe(0);
    const b = await second.mutation(api.respark.batches.claimResparkBatch, {});
    expect((await batchItems(h, b.batchId)).map((row) => row.leadId)).toEqual([item.leadId]);
    // Skip writes nothing on the person.
    expect((await lead(h, item.leadId)).lastTouch?.eventType).toBe("lead.captured");
  });

  it("stays inside the caller's tenant", async () => {
    vi.useFakeTimers();
    const h = await bookingHarness();
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

  it("is only for roles with lead-gen:respark", async () => {
    vi.useFakeTimers();
    const h = await bookingHarness();
    await expect(h.closer.mutation(api.respark.batches.claimResparkBatch, {})).rejects.toThrow();
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
    const h = await bookingHarness();
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
    const h = await bookingHarness();
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

  it("Not a fit leaves a disposition an admin set", async () => {
    vi.useFakeTimers();
    const h = await bookingHarness();
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
    const h = await bookingHarness();
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
    const h = await bookingHarness();
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
