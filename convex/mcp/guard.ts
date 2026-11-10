import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { getIdentityOrgId } from "../lib/identity";
import { expectedError, rejectRequest } from "../lib/observability/errors";
import { logRequestContext } from "../lib/observability/log";
import { hasPermission } from "../lib/permissions";
import type { CrmRole } from "../lib/roleMapping";
import { rememberTenantBusinessDay } from "../lib/tenantBusinessDay";
import {
  getCanonicalIdentityWorkosUserId,
  getRawWorkosUserId,
  getWorkosUserIdCandidates,
} from "../lib/workosUserId";

/**
 * Roles that have a toolset in `convex/mcp/toolsets/`. A role needs a toolset,
 * the `mcp:connect` permission and the tenant's switch before its users get
 * any tool (docs/plans/closer-assistant.md §6.1). Closers have the closer
 * toolset; lead generators and both admin roles have the lead gen toolsets.
 * Adding a role later means writing its toolset and adding it here.
 */
export const MCP_TOOLSET_ROLES = [
  "closer",
  "lead_generator",
  "tenant_admin",
  "tenant_master",
] as const satisfies readonly CrmRole[];

/** The roles each lead gen tool passes to `requireMcpUser`. */
export const LEAD_GEN_ROLES = ["lead_generator"] as const satisfies readonly CrmRole[];
export const LEAD_GEN_ADMIN_ROLES = [
  "tenant_admin",
  "tenant_master",
] as const satisfies readonly CrmRole[];

export function roleHasMcpToolset(role: CrmRole): boolean {
  return (MCP_TOOLSET_ROLES as readonly CrmRole[]).includes(role);
}

/**
 * The caller the gateway injects into every tool's `caller` argument. The
 * gateway resolves it from the verified access token and strips any value a
 * client sends, so it can be trusted the way `ctx.auth` is. Tools run inside
 * the gateway component, where `ctx.auth` is empty, so this is the only
 * identity a tool has.
 */
export const mcpCallerValidator = v.object({
  subject: v.string(),
  claims: v.optional(v.any()),
});

export type McpCaller = { subject: string; claims?: unknown };

export type McpUser = {
  userId: Id<"users">;
  tenantId: Id<"tenants">;
  role: CrmRole;
  workosUserId: string;
  user: Doc<"users">;
  tenant: Doc<"tenants">;
  /** clientInfo.name of the MCP client, or "unknown". */
  agentClient: string;
  /** The user's zone, or the tenant's business-day zone when unset (§5.9). */
  timeZone: string;
};

/** Where a write came from, passed to the shared cores (§6.3). */
export type Provenance = { via: "web" } | { via: "mcp"; agentClient: string };

/** The claim name the HTTP mount adds with the MCP client's name. */
export const MCP_CLIENT_CLAIM = "magnusMcpClient";

function claimsOf(caller: McpCaller): Record<string, unknown> {
  return caller.claims && typeof caller.claims === "object"
    ? (caller.claims as Record<string, unknown>)
    : {};
}

export function agentClientOf(caller: McpCaller): string {
  const name = claimsOf(caller)[MCP_CLIENT_CLAIM];
  return typeof name === "string" && name.trim() ? name.trim().slice(0, 80) : "unknown";
}

export type McpAccessDenial = {
  code:
    | "mcp.not_authenticated"
    | "mcp.user_not_found"
    | "mcp.user_inactive"
    | "mcp.organization_mismatch"
    | "mcp.role_off"
    | "mcp.user_blocked";
  message: string;
};

const DENIAL_MESSAGES: Record<McpAccessDenial["code"], string> = {
  "mcp.not_authenticated": "Sign in to Magnus to use these tools.",
  "mcp.user_not_found": "Magnus has no account for this login. Ask an admin to invite you.",
  "mcp.user_inactive": "Your Magnus account is inactive. Ask an admin.",
  "mcp.organization_mismatch": "This login belongs to another workspace. Sign in again and pick your Magnus workspace.",
  "mcp.role_off": "AI assistant access is off for your role in this workspace.",
  "mcp.user_blocked": "Your AI assistant access is blocked. Ask an admin.",
};

function deny(code: McpAccessDenial["code"]): { ok: false; denial: McpAccessDenial } {
  return { ok: false, denial: { code, message: DENIAL_MESSAGES[code] } };
}

/**
 * Resolves the Magnus user behind an MCP caller and checks every access
 * condition except the per-tool role list. Shared by the gateway's
 * `authorize` callback and `requireMcpUser`, so `tools/list` and each tool
 * agree on who may do what.
 */
export async function resolveMcpAccess(
  ctx: QueryCtx | MutationCtx,
  caller: McpCaller,
): Promise<
  | { ok: true; user: Doc<"users">; tenant: Doc<"tenants">; workosUserId: string }
  | { ok: false; denial: McpAccessDenial }
> {
  const claims = claimsOf(caller);
  const tokenIdentifier =
    typeof claims.tokenIdentifier === "string" ? claims.tokenIdentifier : null;
  const workosUserId = getCanonicalIdentityWorkosUserId({
    tokenIdentifier,
    subject: caller.subject,
  });
  if (!workosUserId) return deny("mcp.not_authenticated");

  let user: Doc<"users"> | null = null;
  for (const candidate of getWorkosUserIdCandidates(workosUserId)) {
    user = await ctx.db
      .query("users")
      .withIndex("by_workosUserId", (q) => q.eq("workosUserId", candidate))
      .unique();
    if (user) break;
  }
  if (!user || user.deletedAt !== undefined) return deny("mcp.user_not_found");
  if (!user.isActive) return deny("mcp.user_inactive");

  const tenant = await ctx.db.get("tenants", user.tenantId);
  if (!tenant) return deny("mcp.user_not_found");
  // A WorkOS user belongs to one tenant here. When the token names an
  // organization, it must be that tenant's.
  const orgId = getIdentityOrgId(claims);
  if (orgId && orgId !== tenant.workosOrgId) return deny("mcp.organization_mismatch");

  if (
    !hasPermission(user.role, "mcp:connect") ||
    !roleHasMcpToolset(user.role) ||
    !(tenant.mcpAccess?.roles ?? []).includes(user.role)
  ) {
    return deny("mcp.role_off");
  }
  if (user.mcpBlockedAt !== undefined) return deny("mcp.user_blocked");
  return { ok: true, user, tenant, workosUserId };
}

/**
 * The guard every MCP tool starts with. Resolves the caller, checks the
 * tenant's switch, the role's toolset, `mcp:connect` and a block, then the
 * roles the tool allows. Throws a `ConvexError`, whose message the gateway
 * passes to the agent.
 */
export async function requireMcpUser(
  ctx: QueryCtx | MutationCtx,
  caller: McpCaller,
  allowedRoles: readonly CrmRole[],
): Promise<McpUser> {
  // Queries re-run on subscription updates, so a rejected query skips the
  // `request.rejected` log line, as requireTenantUser does.
  const reject: typeof rejectRequest =
    "scheduler" in ctx ? rejectRequest : (code, message) => expectedError(code, message);

  const access = await resolveMcpAccess(ctx, caller);
  if (!access.ok) {
    throw reject(access.denial.code, access.denial.message, { subject: caller.subject });
  }
  const { user, tenant, workosUserId } = access;
  if (!allowedRoles.includes(user.role)) {
    throw reject("mcp.role_not_allowed", "This tool isn't available for your role.", {
      userId: user._id,
      role: user.role,
    });
  }

  const businessDay = rememberTenantBusinessDay(ctx, tenant);
  logRequestContext({
    distinctId: getRawWorkosUserId(workosUserId),
    userId: user._id,
    tenantId: user.tenantId,
    workosOrgId: tenant.workosOrgId,
    role: user.role,
  });

  return {
    userId: user._id,
    tenantId: user.tenantId,
    role: user.role,
    workosUserId,
    user,
    tenant,
    agentClient: agentClientOf(caller),
    timeZone: user.timezone ?? businessDay.timeZone,
  };
}

export { clientDisplayName } from "../../lib/agentClient";
