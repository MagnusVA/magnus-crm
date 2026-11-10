import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { env, query, mutation } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { hasPermission } from "../lib/permissions";
import { rejectRequest } from "../lib/observability/errors";
import { log } from "../lib/observability/log";
import schema from "../schema";
import { ADMIN_ROLES, WRITE_FAMILIES, writeFamilyValidator, type WriteFamily } from "./families";
import { MCP_TOOLSET_ROLES, roleHasMcpToolset, writeFamiliesFor } from "./guard";

const roleValidator = schema.tables.users.validator.fields.role;
const adminRoleValidator = v.union(v.literal("tenant_master"), v.literal("tenant_admin"));
const ALL_ROLES = [
  "tenant_master",
  "tenant_admin",
  "closer",
  "lead_generator",
] as const;
const isAdminRole = (role: string) => (ADMIN_ROLES as readonly string[]).includes(role);
const settingsValidator = v.object({
  roles: v.array(roleValidator),
  availableRoles: v.array(roleValidator),
  resourceUrl: v.union(v.string(), v.null()),
  // Admin assistants (docs/plans/admin-assistant.md §4).
  writeRoles: v.array(adminRoleValidator),
  writeFamilies: v.array(writeFamilyValidator),
  families: v.array(writeFamilyValidator),
  canManageAdminAccess: v.boolean(),
});
const resourceUrl = () => env.MCP_RESOURCE_URL?.trim() || null;

type MeLike = { role: string; userId: Doc<"users">["_id"] };

function requireSettingsManager(me: MeLike) {
  if (!hasPermission(me.role, "settings:manage"))
    throw rejectRequest(
      "mcp.settings_denied",
      "You can't manage AI assistant settings.",
    );
}

function requireAdminAccessManager(me: MeLike) {
  if (!hasPermission(me.role, "mcp:manage-admin-access"))
    throw rejectRequest(
      "mcp.owner_only",
      "Only the owner changes AI assistant access for admins.",
    );
}

export const getAiAssistantSettings = query({
  args: {},
  returns: settingsValidator,
  handler: async (ctx) => {
    const me = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    requireSettingsManager(me);
    const tenant = await ctx.db.get("tenants", me.tenantId);
    return {
      roles: tenant?.mcpAccess?.roles ?? [],
      availableRoles: [...MCP_TOOLSET_ROLES].filter((role) =>
        hasPermission(role, "mcp:connect"),
      ),
      resourceUrl: resourceUrl(),
      writeRoles: tenant?.mcpAccess?.writeRoles ?? [],
      writeFamilies: tenant?.mcpAccess?.writeFamilies ?? [],
      families: [...WRITE_FAMILIES],
      canManageAdminAccess: hasPermission(me.role, "mcp:manage-admin-access"),
    };
  },
});

export const setRoles = mutation({
  args: { roles: v.array(roleValidator) },
  returns: v.null(),
  handler: async (ctx, { roles }) => {
    const me = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    requireSettingsManager(me);
    if (
      roles.some(
        (role) =>
          !hasPermission(role, "mcp:connect") || !roleHasMcpToolset(role),
      )
    ) {
      throw rejectRequest(
        "mcp.no_toolset",
        "That role has no AI assistant tools yet.",
      );
    }
    const tenant = await ctx.db.get("tenants", me.tenantId);
    const current = tenant?.mcpAccess?.roles ?? [];
    const uniqueRoles = [...new Set(roles)];
    // Adding or removing an admin role is the owner's decision.
    const adminChanged = ADMIN_ROLES.some(
      (role) => current.includes(role) !== uniqueRoles.includes(role),
    );
    if (adminChanged) requireAdminAccessManager(me);
    // Writes need reading: switching an admin role off clears its writes.
    const writeRoles = (tenant?.mcpAccess?.writeRoles ?? []).filter((role) =>
      uniqueRoles.includes(role),
    );
    const now = Date.now();
    await ctx.db.patch("tenants", me.tenantId, {
      mcpAccess: {
        ...(tenant?.mcpAccess ?? {}),
        roles: uniqueRoles,
        writeRoles,
        changedAt: now,
        changedByUserId: me.userId,
        ...(adminChanged ? { writeChangedAt: now } : {}),
      },
    });
    log.info("mcp.access_changed", {
      tenantId: me.tenantId,
      actorUserId: me.userId,
      roles: uniqueRoles,
    });
    return null;
  },
});

/**
 * Which admin roles' assistants may make changes, and which kinds. Owner only,
 * and a role must already be switched on for reading.
 */
export const setWriteAccess = mutation({
  args: {
    writeRoles: v.array(adminRoleValidator),
    writeFamilies: v.array(writeFamilyValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const me = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    requireSettingsManager(me);
    requireAdminAccessManager(me);
    const tenant = await ctx.db.get("tenants", me.tenantId);
    const reading = tenant?.mcpAccess?.roles ?? [];
    const writeRoles = [...new Set(args.writeRoles)];
    if (writeRoles.some((role) => !reading.includes(role))) {
      throw rejectRequest(
        "mcp.read_first",
        "Switch on AI assistants for that role before letting them make changes.",
      );
    }
    const writeFamilies = [...new Set(args.writeFamilies)] as WriteFamily[];
    const now = Date.now();
    await ctx.db.patch("tenants", me.tenantId, {
      mcpAccess: {
        roles: reading,
        changedAt: tenant?.mcpAccess?.changedAt ?? now,
        changedByUserId: tenant?.mcpAccess?.changedByUserId ?? me.userId,
        writeRoles,
        writeFamilies,
        writeChangedAt: now,
      },
    });
    log.info("mcp.write_access_changed", {
      tenantId: me.tenantId,
      actorUserId: me.userId,
      writeRoles,
      writeFamilies,
    });
    return null;
  },
});

export const setUserBlocked = mutation({
  args: { userId: v.id("users"), blocked: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { userId, blocked }) => {
    const me = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    requireSettingsManager(me);
    const user = await ctx.db.get("users", userId);
    if (!user || user.tenantId !== me.tenantId)
      throw rejectRequest(
        "mcp.user_not_found",
        "That team member isn't in this workspace.",
      );
    // Blocking or unblocking an admin, the caller included, is the owner's.
    if (isAdminRole(user.role)) requireAdminAccessManager(me);
    const now = Date.now();
    await ctx.db.patch("users", userId, {
      mcpBlockedAt: blocked ? now : undefined,
      mcpBlockedByUserId: blocked ? me.userId : undefined,
      mcpBlockChangedAt: now,
    });
    log.info("mcp.user_access_changed", {
      tenantId: me.tenantId,
      actorUserId: me.userId,
      userId,
      blocked,
    });
    return null;
  },
});

export const getMyAiAssistantAccess = query({
  args: {},
  returns: v.object({
    roleEnabled: v.boolean(),
    resourceUrl: v.union(v.string(), v.null()),
    blocked: v.boolean(),
    // Admins: the kinds of change their assistant may make. Empty for reads only.
    writeFamilies: v.array(writeFamilyValidator),
  }),
  handler: async (ctx) => {
    const me = await requireTenantUser(ctx, [...ALL_ROLES]);
    const [tenant, user] = await Promise.all([
      ctx.db.get("tenants", me.tenantId),
      ctx.db.get("users", me.userId),
    ]);
    return {
      roleEnabled:
        hasPermission(me.role, "mcp:connect") &&
        roleHasMcpToolset(me.role) &&
        (tenant?.mcpAccess?.roles ?? []).includes(me.role),
      resourceUrl: resourceUrl(),
      blocked: user?.mcpBlockedAt !== undefined,
      writeFamilies: user && tenant ? writeFamiliesFor(user, tenant) : [],
    };
  },
});
