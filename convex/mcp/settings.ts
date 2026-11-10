import { v } from "convex/values";
import { env, query, mutation } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { hasPermission } from "../lib/permissions";
import { rejectRequest } from "../lib/observability/errors";
import { log } from "../lib/observability/log";
import schema from "../schema";
import { MCP_TOOLSET_ROLES, roleHasMcpToolset } from "./guard";

const roleValidator = schema.tables.users.validator.fields.role;
const ALL_ROLES = [
  "tenant_master",
  "tenant_admin",
  "closer",
  "lead_generator",
] as const;
const settingsValidator = v.object({
  roles: v.array(roleValidator),
  availableRoles: v.array(roleValidator),
  resourceUrl: v.union(v.string(), v.null()),
});
const resourceUrl = () => env.MCP_RESOURCE_URL?.trim() || null;

export const getAiAssistantSettings = query({
  args: {},
  returns: settingsValidator,
  handler: async (ctx) => {
    const me = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    if (!hasPermission(me.role, "settings:manage"))
      throw rejectRequest(
        "mcp.settings_denied",
        "You can't manage AI assistant settings.",
      );
    const tenant = await ctx.db.get("tenants", me.tenantId);
    return {
      roles: tenant?.mcpAccess?.roles ?? [],
      availableRoles: [...MCP_TOOLSET_ROLES].filter((role) =>
        hasPermission(role, "mcp:connect"),
      ),
      resourceUrl: resourceUrl(),
    };
  },
});

export const setRoles = mutation({
  args: { roles: v.array(roleValidator) },
  returns: v.null(),
  handler: async (ctx, { roles }) => {
    const me = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    if (!hasPermission(me.role, "settings:manage"))
      throw rejectRequest(
        "mcp.settings_denied",
        "You can't manage AI assistant settings.",
      );
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
    const uniqueRoles = [...new Set(roles)];
    await ctx.db.patch("tenants", me.tenantId, {
      mcpAccess: {
        roles: uniqueRoles,
        changedAt: Date.now(),
        changedByUserId: me.userId,
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

export const setUserBlocked = mutation({
  args: { userId: v.id("users"), blocked: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { userId, blocked }) => {
    const me = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    if (!hasPermission(me.role, "settings:manage"))
      throw rejectRequest(
        "mcp.settings_denied",
        "You can't manage AI assistant settings.",
      );
    const user = await ctx.db.get("users", userId);
    if (!user || user.tenantId !== me.tenantId)
      throw rejectRequest(
        "mcp.user_not_found",
        "That team member isn't in this workspace.",
      );
    await ctx.db.patch("users", userId, {
      mcpBlockedAt: blocked ? Date.now() : undefined,
      mcpBlockedByUserId: blocked ? me.userId : undefined,
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
    };
  },
});
