import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { bookingHarness } from "../../tests/bookingHarness";
import { recordDealCreation } from "../lib/attribution/dealAttributions";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-20T15:00:00Z");
const START = Date.parse("2026-10-20T07:00:00Z");
const RANGE = {
  kind: "custom" as const,
  startBusinessDate: "2026-10-20",
  endBusinessDateInclusive: "2026-10-20",
};
const DAYS = { startDayKey: "2026-10-20", endDayKey: "2026-10-20" };
type Harness = Awaited<ReturnType<typeof bookingHarness>>;
type Caller = Harness["admin"];
afterEach(() => vi.useRealTimers());

async function worker(
  h: Harness,
  name: string,
  tenantId = h.tenantId,
  orgId = "org_test",
) {
  const workerId = await h.t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      tenantId,
      workosUserId: name,
      email: `${name}@example.com`,
      role: "lead_generator",
      isActive: true,
    });
    const workerId = await ctx.db.insert("leadGenWorkers", {
      tenantId,
      userId,
      workosUserId: name,
      email: `${name}@example.com`,
      displayName: name,
      isActive: true,
      createdAt: 0,
      updatedAt: 0,
    });
    return { workerId, userId };
  });
  return {
    ...workerId,
    caller: h.t.withIdentity({ subject: name, org_id: orgId }),
  };
}

async function capture(
  caller: Caller,
  handle: string,
  at: number,
  source: "instagram" | "meta_business" = "instagram",
) {
  vi.setSystemTime(at);
  await caller.mutation(api.leadGen.capture.submit, {
    source,
    rawHandleOrProfileUrl: `@${handle}`,
    originKind: "follower",
  });
}

async function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const h = await bookingHarness({ transactionLimits: true });
  await h.t.run((ctx) =>
    ctx.db.patch("tenants", h.tenantId, {
      respark: { inactiveAfterDays: 90, batchSize: 10 },
    }),
  );
  const a = await worker(h, "worker_a");
  const b = await worker(h, "worker_b");
  for (let i = 0; i < 14; i++)
    await capture(h.admin, `pool.${i}`, NOW - (40 + i) * DAY);
  return { h, a, b };
}

async function work(
  h: Harness,
  caller: Caller,
  at: number,
  result: "resparked" | "not_a_fit" | "skipped",
) {
  vi.setSystemTime(at);
  const batch = await caller.mutation(
    api.respark.batches.claimResparkBatch,
    {},
  );
  const item = await h.t.run(async (ctx) =>
    (
      await ctx.db
        .query("resparkBatchItems")
        .withIndex("by_batchId_and_position", (q) =>
          q.eq("batchId", batch.batchId!),
        )
        .take(100)
    ).find((row) => !row.result),
  );
  if (!item) throw new Error("No unworked pool item");
  const fn =
    result === "resparked"
      ? api.respark.batches.markResparked
      : result === "not_a_fit"
        ? api.respark.batches.markNotAFit
        : api.respark.batches.skipResparkItem;
  await caller.mutation(fn, { itemId: item._id });
  return item;
}

async function creditedDeal(
  h: Harness,
  leadId: Id<"leads">,
  at: number,
  firstBookedAt?: number,
  tenantId = h.tenantId,
) {
  return await h.t.run(async (ctx) => {
    const opportunityId = await ctx.db.insert("opportunities", {
      tenantId,
      leadId,
      stage: "qualified",
      outcome: "open",
      source: "slack_qualified",
      createdAt: at,
      updatedAt: at,
      firstBookedAt,
    });
    await recordDealCreation(ctx, opportunityId);
    return opportunityId;
  });
}

async function activity(
  caller: Caller,
  size = 25,
  cursor: string | null = null,
) {
  return await caller.query(api.leadGen.activity.listMyRecentSubmissions, {
    range: RANGE,
    paginationOpts: { numItems: size, cursor },
  });
}

describe("respark reports", () => {
  it("keeps a loaded page's rows when new activity arrives, with the page end pinned", async () => {
    const { h, a } = await setup();
    for (let i = 0; i < 4; i++) await capture(a.caller, `paged.${i}`, START + (i + 1) * 60_000);
    vi.setSystemTime(NOW);
    const first = await activity(a.caller, 2);
    const second = await activity(a.caller, 2, first.continueCursor);
    await capture(a.caller, "arrives.later", NOW + 1);
    vi.setSystemTime(NOW);
    // The client pins each loaded page to the cursor it ended at.
    const firstAgain = await a.caller.query(api.leadGen.activity.listMyRecentSubmissions, {
      range: RANGE,
      paginationOpts: { numItems: 2, cursor: null, endCursor: first.continueCursor },
    });
    const ids = (page: { page: { _id: string }[] }) => page.page.map((row) => row._id);
    expect([...ids(firstAgain), ...ids(second)]).toEqual(
      expect.arrayContaining([...ids(first), ...ids(second)]),
    );
    expect(ids(firstAgain)).toHaveLength(3);
    void h;
  });

  it("counts captures and worked results in the business day, merges rows, and excludes skips", async () => {
    const { h, a } = await setup();
    await capture(a.caller, "outside.capture", START - 1);
    await work(h, a.caller, START - 1, "resparked");
    await capture(a.caller, "inside.capture", START);
    const respark = await work(h, a.caller, START, "resparked");
    await work(h, a.caller, NOW, "not_a_fit");
    await work(h, a.caller, NOW + 1, "skipped");
    await capture(a.caller, "future.capture", START + DAY);
    await work(h, a.caller, START + DAY, "resparked");
    vi.setSystemTime(NOW);
    await h.t.run((ctx) =>
      ctx.db.insert("leadGenWorkerSchedules", {
        tenantId: h.tenantId,
        workerId: a.workerId,
        userId: a.userId,
        updatedByUserId: a.userId,
        weekday: "tuesday",
        scheduledHours: 8,
        updatedAt: 0,
      }),
    );
    const summary = await a.caller.query(
      api.leadGen.activity.getMyActivitySummary,
      { range: RANGE },
    );
    expect(summary).toMatchObject({
      submissions: 1,
      resparks: 1,
      entries: 2,
      notAFit: 1,
      scheduledHours: 8,
      leadsPerHour: 0.125,
    });
    const page = await activity(a.caller);
    expect(page.isDone).toBe(true);
    expect(page.page).toHaveLength(3);
    expect(page.page[0]).toMatchObject({
      type: "Respark · not a fit",
      submittedAt: NOW,
      source: "respark",
      originValue: "2 Never qualified",
    });
    expect(page.page.find((row) => row._id === respark._id)).toMatchObject({
      type: "Respark · resparked",
      prospect: { normalizedHandle: expect.stringMatching(/^pool\./) },
    });
    expect(page.page.find((row) => row.type === "Capture")).toMatchObject({
      source: "instagram",
      prospect: { normalizedHandle: "inside.capture" },
    });
    expect(page.page.map((row) => row.submittedAt)).toEqual(
      [...page.page.map((row) => row.submittedAt)].sort((x, y) => y - x),
    );
  });

  it("paginates tied timestamps from both streams without losing or repeating rows", async () => {
    const { h, a } = await setup();
    await work(h, a.caller, NOW, "resparked");
    await work(h, a.caller, NOW, "not_a_fit");
    for (let i = 0; i < 28; i++) await capture(a.caller, `tie.${i}`, NOW);
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const page = await activity(a.caller, 7, cursor);
      ids.push(...page.page.map((row) => row._id));
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    expect(ids).toHaveLength(30);
    expect(new Set(ids).size).toBe(30);
  });

  it("continues past a bounded page containing only skipped items", async () => {
    const { h, a } = await setup();
    await capture(a.caller, "before.skips", NOW - 1);
    const item = await work(h, a.caller, NOW, "skipped");
    await h.t.run(async (ctx) => {
      const { _id, _creationTime, ...fields } = (await ctx.db.get(
        "resparkBatchItems",
        item._id,
      ))!;
      void _id;
      void _creationTime;
      // Fixture copies exercise the read cap; summary aggregates aren't read here.
      for (let i = 0; i < 1_000; i++)
        await ctx.db.insert("resparkBatchItems", fields);
    });
    const first = await activity(a.caller);
    expect(first.page).toEqual([]);
    expect(first.isDone).toBe(false);
    const second = await activity(a.caller, 25, first.continueCursor);
    expect(second.page).toHaveLength(1);
    expect(second.page[0]).toMatchObject({
      type: "Capture",
      prospect: { normalizedHandle: "before.skips" },
    });
    expect(second.isDone).toBe(true);
  });

  it("reports every worker, separates raw source filters, and counts bookings by credit time", async () => {
    const { h, a, b } = await setup();
    const old = await work(h, a.caller, START - 1, "resparked");
    await creditedDeal(h, old.leadId, START, NOW);
    const respark = await work(h, a.caller, START, "resparked");
    await work(h, a.caller, NOW, "not_a_fit");
    // First booking can happen after the selected reporting day.
    await creditedDeal(h, respark.leadId, NOW + 1, NOW + 10 * DAY);
    await capture(a.caller, "a.instagram", NOW);
    await capture(a.caller, "a.meta", NOW, "meta_business");
    await work(h, b.caller, NOW, "resparked");
    await work(h, b.caller, NOW + 1, "not_a_fit");
    // The next day's credit is outside this range.
    const later = await work(h, b.caller, START + DAY, "resparked");
    await creditedDeal(h, later.leadId, START + DAY + 1, START + DAY + 2);
    await capture(b.caller, "b.instagram", NOW);
    vi.setSystemTime(NOW);
    const report = await h.admin.query(
      api.leadGen.resparkReports.listResparkPerformance,
      DAYS,
    );
    expect(report).toMatchObject({
      capped: false,
      rawLeadsCapped: false,
      bookedCapped: false,
    });
    expect(
      report.rows.find((row) => row.workerId === a.workerId),
    ).toMatchObject({
      rawLeads: 2,
      resparks: 1,
      entries: 3,
      notAFit: 1,
      notAFitShare: 0.5,
      resparkedThenBooked: 1,
    });
    expect(
      report.rows.find((row) => row.workerId === b.workerId),
    ).toMatchObject({
      rawLeads: 1,
      resparks: 1,
      entries: 2,
      notAFit: 1,
      notAFitShare: 0.5,
      resparkedThenBooked: 0,
    });
    expect(report.rows.some((row) => row.notAFitShare === null)).toBe(true);
    const filtered = await h.admin.query(
      api.leadGen.resparkReports.listResparkPerformance,
      { ...DAYS, source: "meta_business" },
    );
    expect(
      filtered.rows.find((row) => row.workerId === a.workerId),
    ).toMatchObject({
      rawLeads: 1,
      resparks: 1,
      entries: 2,
      resparkedThenBooked: 1,
    });
    // Respark credit never becomes capture-based Deals credit.
    const conversions = await h.admin.query(
      api.leadGen.conversions.listProspectConversions,
      DAYS,
    );
    expect(conversions.rows.reduce((sum, row) => sum + row.deals, 0)).toBe(0);
  });

  it("does not count an unbooked respark deal", async () => {
    const { h, a } = await setup();
    const item = await work(h, a.caller, NOW, "resparked");
    await creditedDeal(h, item.leadId, NOW + 1);
    const report = await h.admin.query(
      api.leadGen.resparkReports.listResparkPerformance,
      DAYS,
    );
    expect(
      report.rows.find((row) => row.workerId === a.workerId)
        ?.resparkedThenBooked,
    ).toBe(0);
  });

  it("enforces page roles and takes the worker from identity", async () => {
    const { h, a } = await setup();
    await work(h, a.caller, NOW, "resparked");
    await expect(
      h.closer.query(api.leadGen.activity.getMyActivitySummary, {
        range: RANGE,
      }),
    ).rejects.toThrow();
    await expect(activity(h.closer)).rejects.toThrow();
    await expect(
      h.closer.query(api.leadGen.resparkReports.listResparkPerformance, DAYS),
    ).rejects.toThrow();
    await expect(
      a.caller.query(api.leadGen.resparkReports.listResparkPerformance, DAYS),
    ).rejects.toThrow();
    await expect(
      h.t.query(api.leadGen.resparkReports.listResparkPerformance, DAYS),
    ).rejects.toThrow();
    const emptyAdmin = await h.t.run(async (ctx) => {
      await ctx.db.insert("users", {
        tenantId: h.tenantId,
        workosUserId: "no_worker",
        email: "empty@example.com",
        role: "tenant_admin",
        isActive: true,
      });
      return "no_worker";
    });
    const caller = h.t.withIdentity({
      subject: emptyAdmin,
      org_id: "org_test",
    });
    expect(
      await caller.query(api.leadGen.activity.getMyActivitySummary, {
        range: RANGE,
      }),
    ).toMatchObject({ submissions: 0, resparks: 0, entries: 0, notAFit: 0 });
    expect((await activity(caller)).page).toEqual([]);
  });

  it("never includes another tenant's activity or workers", async () => {
    const { h, a } = await setup();
    const tenantId = await h.t.run((ctx) =>
      ctx.db.insert("tenants", {
        companyName: "Other",
        contactEmail: "other@example.com",
        workosOrgId: "org_other",
        status: "active",
        inviteExpiresAt: 0,
        createdBy: "test",
        businessDayAppliedVersion: 0,
      }),
    );
    const other = await worker(h, "worker_other", tenantId, "org_other");
    await capture(other.caller, "other.pool", NOW - 40 * DAY);
    await capture(other.caller, "other.capture", NOW);
    const otherItem = await work(h, other.caller, NOW, "resparked");
    await creditedDeal(h, otherItem.leadId, NOW + 1, NOW + 2, tenantId);
    expect(
      await a.caller.query(api.leadGen.activity.getMyActivitySummary, {
        range: RANGE,
      }),
    ).toMatchObject({ submissions: 0, resparks: 0, entries: 0 });
    expect((await activity(a.caller)).page).toEqual([]);
    const report = await h.admin.query(
      api.leadGen.resparkReports.listResparkPerformance,
      DAYS,
    );
    expect(report.rows.some((row) => row.workerId === other.workerId)).toBe(
      false,
    );
    expect(
      report.rows.every((row) => row.resparks === 0 && row.rawLeads === 0),
    ).toBe(true);
    const otherReport = await other.caller.query(
      api.leadGen.activity.getMyActivitySummary,
      { range: RANGE },
    );
    expect(otherReport).toMatchObject({
      submissions: 1,
      resparks: 1,
      entries: 2,
    });
  });

  it("uses the tenant's configured business-day boundary", async () => {
    const { h, a } = await setup();
    await h.t.run((ctx) =>
      ctx.db.patch("tenants", h.tenantId, {
        businessDay: { timeZone: "UTC", dayStartHour: 10 },
      }),
    );
    await work(h, a.caller, Date.parse("2026-10-20T09:59:59Z"), "resparked");
    await work(h, a.caller, Date.parse("2026-10-20T10:00:00Z"), "resparked");
    const summary = await a.caller.query(
      api.leadGen.activity.getMyActivitySummary,
      { range: RANGE },
    );
    expect(summary.resparks).toBe(1);
    expect((await activity(a.caller)).page).toHaveLength(1);
    const report = await h.admin.query(
      api.leadGen.resparkReports.listResparkPerformance,
      DAYS,
    );
    expect(
      report.rows.find((row) => row.workerId === a.workerId)?.resparks,
    ).toBe(1);
  });

  it("exposes partial booked credit when the indexed read reaches its byte bound", async () => {
    const { h, a } = await setup();
    const item = await work(h, a.caller, NOW, "resparked");
    const opportunityId = await creditedDeal(h, item.leadId, NOW + 1, NOW + 2);
    await h.t.run(async (ctx) => {
      const credits = await ctx.db
        .query("dealAttributions")
        .withIndex("by_tenantId_and_opportunityId_and_role", (q) =>
          q
            .eq("tenantId", h.tenantId)
            .eq("opportunityId", opportunityId)
            .eq("role", "lead_gen"),
        )
        .take(10);
      const credit = credits.find((row) => row.source.kind === "respark")!;
      const { _id, _creationTime, ...fields } = credit;
      void _id;
      void _creationTime;
      // Duplicate fixture credits fill the read budget; the real write path deduplicates them.
      for (let i = 0; i < 2_000; i++)
        await ctx.db.insert("dealAttributions", fields);
    });
    const report = await h.admin.query(
      api.leadGen.resparkReports.listResparkPerformance,
      DAYS,
    );
    expect(report.bookedCapped).toBe(true);
    const booked = report.rows.find(
      (row) => row.workerId === a.workerId,
    )!.resparkedThenBooked;
    expect(booked).toBeGreaterThan(0);
    expect(booked).toBeLessThan(2_001);
  });

  it("marks capped daily stats unavailable instead of presenting incomplete Raw Leads", async () => {
    const { h, a } = await setup();
    await capture(a.caller, "cap.capture", NOW);
    await h.t.run(async (ctx) => {
      const row = await ctx.db
        .query("leadGenDailyStats")
        .withIndex("by_tenantId_and_workerId_and_dayKey", (q) =>
          q.eq("tenantId", h.tenantId).eq("workerId", a.workerId),
        )
        .first();
      const { _id: _id, _creationTime: _creationTime, ...fields } = row!;
      void _id;
      void _creationTime;
      for (let i = 0; i < 500; i++)
        await ctx.db.insert("leadGenDailyStats", fields);
    });
    const report = await h.admin.query(
      api.leadGen.resparkReports.listResparkPerformance,
      DAYS,
    );
    expect(report.rawLeadsCapped).toBe(true);
    const filtered = await h.admin.query(
      api.leadGen.resparkReports.listResparkPerformance,
      { ...DAYS, source: "meta_business" },
    );
    expect(filtered.rawLeadsCapped).toBe(false);
    expect(
      filtered.rows.find((row) => row.workerId === a.workerId)?.rawLeads,
    ).toBe(0);
    expect(
      report.rows.find((row) => row.workerId === a.workerId),
    ).toMatchObject({ rawLeads: null, entries: null });
  });
});
