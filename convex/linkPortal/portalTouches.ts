import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { emitDomainEvent } from "../lib/domainEvents";

// DM portal activity is a touch on the person's timeline
// (docs/plans/phase-2-person-first.md §4.3). Since Respark it doesn't move the
// stage: a capture or a respark means in conversation (docs/plans/respark.md
// §4.2). DM closers act through a shared password, not as CRM users, so the
// event names the DM closer's team member and no actor.

export const PORTAL_LINK_COPIED = "lead.portal_link_copied";
export const PORTAL_NOTE_ADDED = "lead.portal_note_added";
export const PORTAL_PROFILE_UPDATED = "lead.portal_profile_updated";

export type PortalTouchType =
  | typeof PORTAL_LINK_COPIED
  | typeof PORTAL_NOTE_ADDED
  | typeof PORTAL_PROFILE_UPDATED;

export async function emitPortalTouch(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    leadId: Id<"leads">;
    dmCloser: Doc<"dmClosers">;
    eventType: PortalTouchType;
    at: number;
    metadata: Record<string, unknown>;
    skipAnalytics?: boolean;
  },
): Promise<void> {
  await emitDomainEvent(ctx, {
    tenantId: args.tenantId,
    entityType: "lead",
    entityId: args.leadId,
    eventType: args.eventType,
    source: "pipeline",
    teamMemberId: args.dmCloser.teamMemberId,
    metadata: { dmCloserId: args.dmCloser._id, ...args.metadata },
    occurredAt: args.at,
    skipAnalytics: args.skipAnalytics,
  });
}

/** Records the touch. */
export async function recordPortalTouch(
  ctx: MutationCtx,
  args: Parameters<typeof emitPortalTouch>[1],
): Promise<void> {
  await emitPortalTouch(ctx, args);
}
