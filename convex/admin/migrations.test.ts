import { convexTest } from "convex-test";
import { expect, it } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";
import { convexTestModules } from "../test.setup";

it("deleteTenantStatsRows previews IDs, deletes rows, and is safe to rerun", async () => {
  const t = convexTest(schema, convexTestModules);
  const ids = await t.run(async (ctx) => {
    const ids = [];
    for (const name of ["First", "Second"]) {
      const tenantId = await ctx.db.insert("tenants", {
        companyName: name,
        contactEmail: "admin@example.com",
        workosOrgId: `org_${name}`,
        inviteExpiresAt: 0,
        status: "active",
        createdBy: "test",
      });
      ids.push(await ctx.db.insert("tenantStats", {
        tenantId,
        totalTeamMembers: 1,
        totalClosers: 1,
        totalOpportunities: 1,
        totalRevenueMinor: 100,
        totalPaymentRecords: 1,
        totalLeads: 1,
        totalCustomers: 1,
        lastUpdatedAt: 0,
      }));
    }
    return ids;
  });
  const before = await t.run((ctx) => ctx.db.query("tenantStats").take(100));

  expect(await t.mutation(internal.admin.migrations.deleteTenantStatsRows, { dryRun: true })).toEqual({
    dryRun: true, found: 2, deleted: 0, ids,
  });
  expect(await t.run((ctx) => ctx.db.query("tenantStats").take(100))).toEqual(before);

  expect(await t.mutation(internal.admin.migrations.deleteTenantStatsRows, {})).toEqual({
    dryRun: false, found: 2, deleted: 2, ids,
  });
  expect(await t.run((ctx) => ctx.db.query("tenantStats").take(100))).toEqual([]);
  expect(await t.mutation(internal.admin.migrations.deleteTenantStatsRows, { dryRun: false })).toEqual({
    dryRun: false, found: 0, deleted: 0, ids: [],
  });
});

it("deleteTenantStatsRows handles at most 100 rows per call", async () => {
  const t = convexTest(schema, convexTestModules);
  await t.run(async (ctx) => {
    const tenantId = await ctx.db.insert("tenants", {
      companyName: "Tenant",
      contactEmail: "admin@example.com",
      workosOrgId: "org_tenant",
      inviteExpiresAt: 0,
      status: "active",
      createdBy: "test",
    });
    for (let i = 0; i < 101; i++) {
      await ctx.db.insert("tenantStats", {
        tenantId,
        totalTeamMembers: 0,
        totalClosers: 0,
        totalOpportunities: 0,
        totalRevenueMinor: 0,
        totalPaymentRecords: 0,
        totalLeads: 0,
        totalCustomers: 0,
        lastUpdatedAt: 0,
      });
    }
  });

  const preview = await t.mutation(internal.admin.migrations.deleteTenantStatsRows, { dryRun: true });
  expect(preview).toMatchObject({ dryRun: true, found: 100, deleted: 0 });
  expect(preview.ids).toHaveLength(100);
  expect(await t.mutation(internal.admin.migrations.deleteTenantStatsRows, {})).toEqual({
    dryRun: false, found: 100, deleted: 100, ids: preview.ids,
  });
  const remaining = await t.run((ctx) => ctx.db.query("tenantStats").take(100));
  expect(remaining).toHaveLength(1);
  expect(await t.mutation(internal.admin.migrations.deleteTenantStatsRows, {})).toEqual({
    dryRun: false, found: 1, deleted: 1, ids: [remaining[0]._id],
  });
  expect(await t.run((ctx) => ctx.db.query("tenantStats").take(100))).toEqual([]);
});
