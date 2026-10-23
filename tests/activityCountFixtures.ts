import type { Doc, Id } from "../convex/_generated/dataModel";
import type { MutationCtx } from "../convex/_generated/server";
import { insertActivityEventCounts } from "../convex/reporting/activityEventCounts";

export async function activityEvent(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  fields: Partial<
    Omit<Doc<"domainEvents">, "_id" | "_creationTime" | "tenantId">
  > = {},
  aggregate = true,
) {
  const id = await ctx.db.insert("domainEvents", {
    tenantId,
    entityType: "user",
    entityId: "historical",
    eventType: "user.created",
    occurredAt: Date.now(),
    source: "admin",
    ...fields,
  });
  const event = await ctx.db.get("domainEvents", id);
  if (!event) throw new Error("Missing fixture event");
  if (aggregate) await insertActivityEventCounts(ctx, event);
  return event;
}

/** The blocker purge targets rows from before assignedCloserId was required. */
export async function legacyActivityHarness() {
  const { convexTest } = await import("convex-test");
  const { defineSchema } = await import("convex/server");
  const { default: schema } = await import("../convex/schema");
  const { convexTestModules } = await import("../convex/test.setup");
  const { registerComponents } = await import("./bookingHarness");
  const t = convexTest({
    schema: defineSchema(schema.tables, { schemaValidation: false }),
    modules: convexTestModules,
  });
  registerComponents(t);
  const tenantId = await t.run(async (ctx) => {
    const tenantId = await ctx.db.insert("tenants", {
      companyName: "Legacy",
      contactEmail: "admin@example.com",
      workosOrgId: "org_legacy",
      status: "active",
      inviteExpiresAt: 0,
      createdBy: "test",
    });
    await ctx.db.insert("users", {
      tenantId,
      workosUserId: "user_admin",
      email: "admin@example.com",
      role: "tenant_admin",
      isActive: true,
    });
    await ctx.db.insert("users", {
      tenantId,
      workosUserId: "user_closer",
      email: "closer@example.com",
      role: "closer",
      isActive: true,
    });
    return tenantId;
  });
  return { t, tenantId };
}
