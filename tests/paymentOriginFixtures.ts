import migrationsTest from "@convex-dev/migrations/test";
import { defineSchema } from "convex/server";
import { convexTest } from "convex-test";
import { vi } from "vitest";
import { internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { migrations } from "../convex/migrations";
import { convexTestModules } from "../convex/test.setup";
import { registerComponents, qualifiedLifecycle } from "./bookingHarness";
import { stageFields } from "./dealStageFixtures";

export async function paymentOriginHarness(allowInvalidStoredRows = false) {
  vi.useFakeTimers();
  const t = convexTest({
    // Only corruption tests disable validation, to model rows a narrowed
    // origin validator no longer accepts.
    schema: allowInvalidStoredRows
      ? defineSchema(schema.tables, { schemaValidation: false })
      : schema,
    modules: convexTestModules,
  });
  registerComponents(t);
  migrationsTest.register(t);
  const ids = await t.run(async (ctx) => {
    const tenantId = await ctx.db.insert("tenants", {
      companyName: "Test", contactEmail: "admin@example.com", workosOrgId: "org_test",
      status: "active", inviteExpiresAt: 0, createdBy: "test",
    });
    const closerId = await ctx.db.insert("users", {
      tenantId, workosUserId: "user_closer", email: "closer@example.com", role: "closer", isActive: true,
    });
    await ctx.db.insert("users", {
      tenantId, workosUserId: "user_admin", email: "admin@example.com", role: "tenant_admin", isActive: true,
    });
    const programId = await ctx.db.insert("tenantPrograms", {
      tenantId, name: "Program", normalizedName: "program", createdByUserId: closerId, createdAt: 0, updatedAt: 0,
    });
    const leadId = await ctx.db.insert("leads", {
      tenantId, ...qualifiedLifecycle(0), email: "person@example.com", status: "active", firstSeenAt: 0, updatedAt: 0,
    });
    const opportunityId = await ctx.db.insert("opportunities", {
      tenantId, leadId, assignedCloserId: closerId, ...stageFields("payment_received", "calendly"), createdAt: 0, updatedAt: 0,
    });
    return { tenantId, closerId, programId, leadId, opportunityId };
  });
  const payment = {
    tenantId: ids.tenantId, opportunityId: ids.opportunityId, attributedCloserId: ids.closerId,
    recordedByUserId: ids.closerId, programId: ids.programId, programName: "Program",
    amountMinor: 10_000, currency: "USD", paymentType: "pif" as const,
    status: "recorded" as const, recordedAt: 1000, origin: "closer_meeting" as const,
  };
  async function run(name: string, reset = false) {
    await t.mutation(internal.migrations.run, { fn: `migrations:${name}`, reset });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const [result] = await t.run((ctx) => migrations.getStatus(ctx, { migrations: [`migrations:${name}`] as never }));
    return result;
  }
  return {
    t, ...ids, payment, run,
    admin: t.withIdentity({ subject: "user_admin", org_id: "org_test" }),
  };
}
