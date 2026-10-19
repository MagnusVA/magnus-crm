/**
 * Code that reads leads in bulk keeps working once lead gen prospects, which
 * far outnumber leads, are persons (docs/plans/phase-2-person-first.md §8).
 */
import { afterEach, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { bookingHarness, qualifiedLifecycle } from "../../tests/bookingHarness";
import { rebuildLeadCustomerSearchRow } from "../leadCustomers/projection";
import { resolveLeadIdentity } from "./identityResolution";

afterEach(() => vi.useRealTimers());

const AT = Date.parse("2026-10-01T00:00:00Z");

async function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-14T00:00:00Z"));
  return await bookingHarness();
}

async function insertPerson(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  fields: { fullName?: string; email?: string; handle?: string; prospect?: boolean; at?: number },
) {
  const at = fields.at ?? AT;
  const leadId = await ctx.db.insert("leads", {
    tenantId,
    ...(fields.prospect
      ? {
          lifecycleStage: "prospect" as const,
          lifecycleStageEnteredAt: { prospect: at },
          disposition: "open" as const,
        }
      : qualifiedLifecycle(at)),
    status: "active",
    fullName: fields.fullName,
    email: fields.email,
    socialHandles: fields.handle ? [{ type: "instagram", handle: fields.handle }] : undefined,
    searchText: [fields.fullName, fields.email, fields.handle].filter(Boolean).join(" "),
    firstSeenAt: at,
    updatedAt: at,
  });
  await rebuildLeadCustomerSearchRow(ctx, tenantId, leadId);
  return leadId;
}

it("flags a likely duplicate behind more than 50 newer prospects", async () => {
  const { t, tenantId } = await setup();
  const existingId = await t.run(async (ctx) => {
    const existingId = await insertPerson(ctx, tenantId, {
      fullName: "Sam Smith",
      email: "sam@acme.io",
    });
    for (let i = 0; i < 60; i++) {
      await insertPerson(ctx, tenantId, { handle: `prospect${i}`, prospect: true, at: AT + i + 1 });
    }
    return existingId;
  });

  const result = await t.run((ctx) =>
    resolveLeadIdentity(ctx, {
      tenantId,
      fullName: "Sam Smith",
      email: "samuel@acme.io",
      identifierSource: "calendly_booking",
      createdAt: AT + 100,
      initialLifecycle: { stage: "booked", at: AT + 100 },
    }),
  );

  expect(result.potentialDuplicateLeadId).toBe(existingId);
});

it("checks the newest leads, whatever their activity", async () => {
  const { t, tenantId } = await setup();
  const newestId = await t.run(async (ctx) => {
    for (let i = 0; i < 55; i++) {
      const leadId = await insertPerson(ctx, tenantId, { fullName: `Busy ${i}`, email: `busy${i}@other.io`, at: AT - 1_000 - i });
      const row = await ctx.db
        .query("leadCustomerSearchRows")
        .withIndex("by_tenantId_and_leadId", (q) => q.eq("tenantId", tenantId).eq("leadId", leadId))
        .unique();
      await ctx.db.patch("leadCustomerSearchRows", row!._id, { latestActivityAt: AT + 10_000 });
    }
    return await insertPerson(ctx, tenantId, { fullName: "Sam Smith", email: "sam@acme.io" });
  });

  const result = await t.run((ctx) =>
    resolveLeadIdentity(ctx, {
      tenantId,
      fullName: "Sam Smith",
      email: "samuel@acme.io",
      identifierSource: "calendly_booking",
      createdAt: AT + 100,
      initialLifecycle: { stage: "booked", at: AT + 100 },
    }),
  );

  expect(result.potentialDuplicateLeadId).toBe(newestId);
});

it("leaves prospects out of the merge picker's search", async () => {
  const { t, tenantId, admin } = await setup();
  const leadId = await t.run(async (ctx) => {
    for (let i = 0; i < 25; i++) {
      await insertPerson(ctx, tenantId, { handle: `samfit${i}`, fullName: "samfit", prospect: true });
    }
    return await insertPerson(ctx, tenantId, { fullName: "samfit", email: "samfit@example.com" });
  });

  const results = await admin.query(api.leads.queries.searchLeads, { searchTerm: "samfit" });

  expect(results.map((lead) => lead._id)).toEqual([leadId]);
});

it("counts tenantStats.totalLeads in pages, leaving out prospects", async () => {
  const { t, tenantId } = await setup();
  await t.run(async (ctx) => {
    await insertPerson(ctx, tenantId, { fullName: "Lead" });
    await insertPerson(ctx, tenantId, { handle: "someprospect", prospect: true });
    const converted = await insertPerson(ctx, tenantId, { fullName: "Customer" });
    await ctx.db.patch("leads", converted, { status: "converted" });
  });

  const page = await t.query(internal.admin.migrations.countTenantLeadsPage, {
    tenantId,
    cursor: null,
  });

  expect(page).toMatchObject({ count: 1, isDone: true });
});

it("counts closer actions past 5,000 pipeline events, including a closer since made an admin", async () => {
  const { t, tenantId, admin } = await setup();
  await t.run(async (ctx) => {
    const closer = await ctx.db
      .query("users")
      .withIndex("by_workosUserId", (q) => q.eq("workosUserId", "user_closer"))
      .unique();
    await ctx.db.patch("users", closer!._id, { role: "tenant_admin" });
    for (let i = 0; i < 5_001; i++) {
      await ctx.db.insert("domainEvents", {
        tenantId,
        entityType: "lead",
        entityId: "lead",
        eventType: "lead.captured",
        occurredAt: AT + i,
        source: "pipeline",
      });
    }
    await ctx.db.insert("domainEvents", {
      tenantId,
      entityType: "opportunity",
      entityId: "opportunity",
      eventType: "opportunity.status_changed",
      occurredAt: AT + 10_000,
      source: "closer",
      actorUserId: closer!._id,
    });
  });

  const report = await admin.query(api.reporting.teamActions.getActionsPerCloserPerDay, {
    startDate: AT,
    endDate: AT + 86_400_000,
  });

  expect(report).toMatchObject({ totalCloserActions: 1, distinctCloserActors: 1, isTruncated: false });
});
