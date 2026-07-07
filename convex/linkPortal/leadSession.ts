// NIM-17 Phase 5: shared guards for portal lead functions.
//
// Plain helpers (no function registrations) used by both
// linkPortal/leadQueries.ts and linkPortal/leadMutations.ts. They mirror the
// established portal trust model (see copyMutations.insertCopyEvent):
// - the tenant always comes from the verified session token, never from the
//   client beyond that;
// - the client-chosen dmCloserId is validated as an active closer of the
//   tenant (with an active team);
// - every document crossing the portal boundary is tenant-checked.

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/**
 * Asserts the portal session (already signature-verified by the "use node"
 * action) still matches the live portal config: enabled, same slug, same
 * session version. Throws the generic portal error otherwise.
 */
export async function assertActivePortalSession(
  ctx: QueryCtx | MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    publicSlug: string;
    sessionVersion: number;
  },
): Promise<void> {
  const config = await ctx.db
    .query("linkPortalConfigs")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", args.tenantId))
    .unique();
  if (
    !config ||
    !config.isEnabled ||
    config.publicSlug !== args.publicSlug ||
    config.sessionVersion !== args.sessionVersion
  ) {
    throw new Error("Portal session is no longer valid.");
  }
}

/**
 * Validates the client-chosen dmCloserId belongs to the tenant, is active,
 * and sits on an active team (same trust level as recordCopyEvent).
 */
export async function requirePortalDmCloser(
  ctx: QueryCtx | MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    dmCloserId: Id<"dmClosers">;
  },
): Promise<Doc<"dmClosers">> {
  const dmCloser = await ctx.db.get(args.dmCloserId);
  if (!dmCloser || dmCloser.tenantId !== args.tenantId || !dmCloser.isActive) {
    throw new Error("DM closer is not available.");
  }

  const team = await ctx.db.get(dmCloser.teamId);
  if (!team || team.tenantId !== args.tenantId || !team.isActive) {
    throw new Error("Attribution team is not available.");
  }

  return dmCloser;
}

/**
 * Loads a lead and asserts it belongs to the tenant and has not been merged
 * away. Portal writes and note reads must never touch another tenant's lead.
 */
export async function requirePortalLead(
  ctx: QueryCtx | MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    leadId: Id<"leads">;
  },
): Promise<Doc<"leads">> {
  const lead = await ctx.db.get(args.leadId);
  if (!lead || lead.tenantId !== args.tenantId || lead.status === "merged") {
    throw new Error("Lead is not available.");
  }
  return lead;
}

/**
 * PII-safe display name for the portal: full name, falling back to the first
 * denormalized social handle. Never email or phone.
 */
export function portalLeadDisplayName(lead: Doc<"leads">): string {
  const fullName = lead.fullName?.trim();
  if (fullName) {
    return fullName;
  }
  const firstHandle = lead.socialHandles?.[0];
  if (firstHandle) {
    return `@${firstHandle.handle}`;
  }
  return "Unknown lead";
}
