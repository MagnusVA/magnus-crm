import type { Id } from "../convex/_generated/dataModel";
import type { WriteFamily } from "../convex/mcp/families";
import { createMcpHarness, mcpConnect, seedTenantWithCloser, type McpHarness } from "./mcpHarness";

const UM = "https://api.workos.com/user_management/client_test";

/**
 * A tenant with an owner, an admin and a closer, for the admin toolset
 * (docs/plans/admin-assistant.md). Reading is on for both admin roles unless
 * `read: false`; writes follow `writeFamilies`.
 */
export async function seedAdminTenant(
  t: McpHarness["t"],
  options: { read?: boolean; writeFamilies?: WriteFamily[]; orgId?: string; prefix?: string } = {},
) {
  const prefix = options.prefix ?? "";
  const base = await seedTenantWithCloser(t, {
    orgId: options.orgId,
    workosUserId: `${UM}|${prefix}user_alex`,
  });
  return await t.run(async (ctx) => {
    await ctx.db.patch("users", base.ownerId, { workosUserId: `${UM}|${prefix}user_owner` });
    const adminId = await ctx.db.insert("users", {
      tenantId: base.tenantId,
      workosUserId: `${UM}|${prefix}user_jordan`,
      email: "jordan@northwind.example",
      fullName: "Jordan Park",
      role: "tenant_admin",
      isActive: true,
      timezone: "America/Tegucigalpa",
    });
    const read = options.read ?? true;
    await ctx.db.patch("tenants", base.tenantId, {
      billingOpsEnabled: true,
      mcpAccess: {
        roles: read ? ["closer", "tenant_master", "tenant_admin"] : ["closer"],
        changedAt: 1,
        changedByUserId: base.ownerId,
        writeRoles: read && options.writeFamilies?.length ? ["tenant_master", "tenant_admin"] : [],
        writeFamilies: options.writeFamilies ?? [],
        writeChangedAt: 1,
      },
    });
    return { ...base, adminId } as typeof base & { adminId: Id<"users"> };
  });
}

export async function adminFixture(options: Parameters<typeof seedAdminTenant>[1] = {}) {
  const { t, signToken } = await createMcpHarness();
  const seeded = await seedAdminTenant(t, options);
  const adminToken = await signToken("user_jordan", { org_id: seeded.orgId });
  const ownerToken = await signToken("user_owner", { org_id: seeded.orgId });
  const closerToken = await signToken("user_alex", { org_id: seeded.orgId });
  const admin = await mcpConnect(t, adminToken);
  return {
    t,
    signToken,
    ...seeded,
    adminToken,
    ownerToken,
    closerToken,
    adminSession: admin.sessionId,
    adminInit: admin.init,
    ownerWeb: t.withIdentity({ subject: "user_owner", org_id: seeded.orgId }),
    adminWeb: t.withIdentity({ subject: "user_jordan", org_id: seeded.orgId }),
    closerWeb: t.withIdentity({ subject: "user_alex", org_id: seeded.orgId }),
  };
}

/** The caller the gateway would inject for the admin. */
export function adminCaller(orgId: string, client = "claude-ai", sub = "user_jordan") {
  return {
    subject: sub,
    claims: { tokenIdentifier: `https://magnus-test.authkit.app|${sub}`, org_id: orgId, magnusMcpClient: client },
  };
}
