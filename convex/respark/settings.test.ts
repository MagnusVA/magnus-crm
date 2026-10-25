import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { bookingHarness } from "../../tests/bookingHarness";
import { DAY_MS, inactiveDays } from "../lib/respark/settings";

afterEach(() => vi.useRealTimers());

type Harness = Awaited<ReturnType<typeof bookingHarness>>;
type Identity = Harness["admin"];

const NOW = Date.parse("2026-10-24T15:00:00Z");

async function capture(as: Identity, handle: string, at: number) {
  vi.setSystemTime(new Date(at));
  await as.mutation(api.leadGen.capture.submit, {
    source: "instagram", rawHandleOrProfileUrl: `@${handle}`, originKind: "follower",
  });
}

async function leadByTouch(harness: Harness, at: number): Promise<Doc<"leads">> {
  const all = await harness.t.run(async (ctx) => await ctx.db.query("leads").take(20));
  return all.find((lead) => lead.lastTouch?.occurredAt === at)!;
}

async function addUser(harness: Harness, tenantId: Id<"tenants">, workosUserId: string, role: Doc<"users">["role"]) {
  await harness.t.run(async (ctx) => {
    await ctx.db.insert("users", { tenantId, workosUserId, email: `${workosUserId}@example.com`, role, isActive: true });
  });
}

/** A second tenant with its own admin. */
async function otherTenant(harness: Harness) {
  const tenantId = await harness.t.run(async (ctx) =>
    await ctx.db.insert("tenants", {
      businessDayAppliedVersion: 0, companyName: "Other", contactEmail: "o@example.com",
      workosOrgId: "org_other", status: "active", inviteExpiresAt: 0, createdBy: "test",
      businessDay: { timeZone: "UTC", dayStartHour: 6 },
    }),
  );
  await addUser(harness, tenantId, "user_other_admin", "tenant_admin");
  return { tenantId, admin: harness.t.withIdentity({ subject: "user_other_admin", org_id: "org_other" }) };
}

// Three people in tenant A, touched 200, 100 and 40 days before NOW.
async function seed(harness: Harness) {
  await capture(harness.admin, "respark.old", NOW - 200 * DAY_MS);
  await capture(harness.admin, "respark.mid", NOW - 100 * DAY_MS);
  await capture(harness.admin, "respark.new", NOW - 40 * DAY_MS);
  // Inactive counts every group, not a fit included.
  const old = await leadByTouch(harness, NOW - 200 * DAY_MS);
  await harness.admin.mutation(api.leads.lifecycleAdmin.setDisposition, {
    leadId: old._id, disposition: "not_a_fit", reason: "Test",
  });
  expect((await leadByTouch(harness, NOW - 200 * DAY_MS)).resparkGroup).toBe("not_a_fit");
  vi.setSystemTime(new Date(NOW));
}

describe("respark settings", () => {
  it("returns the defaults, the business day and the inactive count", async () => {
    vi.useFakeTimers();
    const harness = await bookingHarness();
    await seed(harness);

    expect(await harness.admin.query(api.respark.settings.getResparkSettings, {})).toEqual({
      settings: { inactiveAfterDays: 90, batchSize: 45 },
      businessDay: { timeZone: "America/Tegucigalpa", dayStartHour: 1 },
      inactive: { inactiveAfterDays: 90, count: 2 },
    });
  });

  it("previews the count for another number of days, inclusive of the cutoff", async () => {
    vi.useFakeTimers();
    const harness = await bookingHarness();
    await seed(harness);
    const preview = async (inactiveAfterDays: number) =>
      (await harness.admin.query(api.respark.settings.getResparkSettings, { inactiveAfterDays })).inactive;

    expect(await preview(30)).toEqual({ inactiveAfterDays: 30, count: 3 });
    // A touch exactly 100 days ago is inactive at 100 days.
    expect(await preview(100)).toEqual({ inactiveAfterDays: 100, count: 2 });
    expect(await preview(101)).toEqual({ inactiveAfterDays: 101, count: 1 });
    expect(await preview(365)).toEqual({ inactiveAfterDays: 365, count: 0 });
    // A value that can't be saved gets no count.
    expect(await preview(29)).toBeNull();
    expect(await preview(90.5)).toBeNull();
  });

  it("saves the settings, which the count then uses", async () => {
    vi.useFakeTimers();
    const harness = await bookingHarness();
    await seed(harness);

    await harness.admin.mutation(api.respark.settings.updateResparkSettings, { inactiveAfterDays: 30, batchSize: 100 });
    expect(await harness.t.run(async (ctx) => (await ctx.db.get("tenants", harness.tenantId))?.respark))
      .toEqual({ inactiveAfterDays: 30, batchSize: 100 });
    expect(await harness.admin.query(api.respark.settings.getResparkSettings, {})).toMatchObject({
      settings: { inactiveAfterDays: 30, batchSize: 100 },
      inactive: { inactiveAfterDays: 30, count: 3 },
    });
    await harness.admin.mutation(api.respark.settings.updateResparkSettings, { inactiveAfterDays: 365, batchSize: 10 });
    expect((await harness.admin.query(api.respark.settings.getResparkSettings, {})).settings)
      .toEqual({ inactiveAfterDays: 365, batchSize: 10 });
  });

  it("rejects values outside the bounds and leaves the settings alone", async () => {
    const harness = await bookingHarness();
    const update = (inactiveAfterDays: number, batchSize: number) =>
      harness.admin.mutation(api.respark.settings.updateResparkSettings, { inactiveAfterDays, batchSize });

    for (const days of [29, 366, 90.5, -1]) {
      await expect(update(days, 45)).rejects.toThrow(/Inactive after must be a whole number of days from 30 to 365/);
    }
    for (const size of [9, 101, 45.5, 0]) {
      await expect(update(90, size)).rejects.toThrow(/Batch size must be a whole number from 10 to 100/);
    }
    expect(await harness.t.run(async (ctx) => (await ctx.db.get("tenants", harness.tenantId))?.respark ?? null)).toBeNull();
  });

  it("is only for settings:manage", async () => {
    const harness = await bookingHarness();
    await addUser(harness, harness.tenantId, "user_lead_gen", "lead_generator");
    const leadGen = harness.t.withIdentity({ subject: "user_lead_gen", org_id: "org_test" });
    await addUser(harness, harness.tenantId, "user_owner", "tenant_master");
    const owner = harness.t.withIdentity({ subject: "user_owner", org_id: "org_test" });

    for (const as of [harness.closer, leadGen]) {
      await expect(as.query(api.respark.settings.getResparkSettings, {})).rejects.toThrow(/Insufficient permissions/i);
      await expect(as.mutation(api.respark.settings.updateResparkSettings, { inactiveAfterDays: 60, batchSize: 20 }))
        .rejects.toThrow(/Insufficient permissions/i);
    }
    await expect(harness.t.query(api.respark.settings.getResparkSettings, {})).rejects.toThrow(/Not authenticated/);
    await owner.mutation(api.respark.settings.updateResparkSettings, { inactiveAfterDays: 60, batchSize: 20 });
    expect((await harness.admin.query(api.respark.settings.getResparkSettings, {})).settings)
      .toEqual({ inactiveAfterDays: 60, batchSize: 20 });
  });

  it("reads and writes only the caller's tenant", async () => {
    vi.useFakeTimers();
    const harness = await bookingHarness();
    await seed(harness);
    const other = await otherTenant(harness);
    await other.admin.mutation(api.respark.settings.updateResparkSettings, { inactiveAfterDays: 30, batchSize: 15 });

    // Tenant A keeps its defaults and counts only its own people.
    expect(await harness.admin.query(api.respark.settings.getResparkSettings, { inactiveAfterDays: 30 })).toEqual({
      settings: { inactiveAfterDays: 90, batchSize: 45 },
      businessDay: { timeZone: "America/Tegucigalpa", dayStartHour: 1 },
      inactive: { inactiveAfterDays: 30, count: 3 },
    });
    // Tenant B sees its own settings and business day, and none of A's people.
    expect(await other.admin.query(api.respark.settings.getResparkSettings, {})).toEqual({
      settings: { inactiveAfterDays: 30, batchSize: 15 },
      businessDay: { timeZone: "UTC", dayStartHour: 6 },
      inactive: { inactiveAfterDays: 30, count: 0 },
    });
    expect(await harness.t.run(async (ctx) => (await ctx.db.get("tenants", harness.tenantId))?.respark ?? null)).toBeNull();
  });
});

describe("the person page's respark fields", () => {
  it("returns the last touch with its label and the tenant's inactive days", async () => {
    vi.useFakeTimers();
    const harness = await bookingHarness();
    await seed(harness);
    const mid = await leadByTouch(harness, NOW - 100 * DAY_MS);

    const detail = await harness.admin.query(api.leadCustomers.detail.getEntityDetail, { leadId: mid._id });
    expect(detail).toMatchObject({
      kind: "detail",
      lastTouch: { eventId: mid.lastTouch!.eventId, eventType: "lead.captured", occurredAt: NOW - 100 * DAY_MS, label: "Captured by lead gen" },
      inactiveAfterDays: 90,
    });
    expect(inactiveDays(mid, 90, NOW)).toBe(100);
    expect(inactiveDays(mid, 101, NOW)).toBeNull();
    expect(inactiveDays({ ...mid, status: "merged" }, 90, NOW)).toBeNull();

    await harness.admin.mutation(api.respark.settings.updateResparkSettings, { inactiveAfterDays: 120, batchSize: 45 });
    expect(await harness.admin.query(api.leadCustomers.detail.getEntityDetail, { leadId: mid._id }))
      .toMatchObject({ inactiveAfterDays: 120 });
  });

  it("returns a null last touch for a person without one", async () => {
    vi.useFakeTimers();
    const harness = await bookingHarness();
    await seed(harness);
    const mid = await leadByTouch(harness, NOW - 100 * DAY_MS);
    await harness.t.run(async (ctx) => { await ctx.db.patch("leads", mid._id, { lastTouch: undefined }); });

    expect(await harness.admin.query(api.leadCustomers.detail.getEntityDetail, { leadId: mid._id }))
      .toMatchObject({ lastTouch: null, inactiveAfterDays: 90 });
  });
});
