import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/**
 * v2 — Late-start review helper.
 *
 * A "closer already acted" signal on a still-`meeting_overran` opportunity.
 * When the closer creates a follow-up (scheduling link or manual reminder)
 * on a flagged opportunity, the follow-up mutations intentionally skip the
 * status transition (see `plans/Late-start-reviewv2/overhaul-v2.md` §14.6
 * and §5.4) — so the opportunity stays `meeting_overran` even though the
 * closer has taken action. Callers use the presence of a `pending`
 * follow-up to detect that case.
 *
 * Shared by:
 *  - closer meeting detail query (banner + action-bar UX)
 *  - admin review queries (resolution bar UX)
 *  - admin review mutations (dispute-time expiration + event metadata)
 */
export type ActiveFollowUpSummary = {
  _id: Id<"followUps">;
  type: Doc<"followUps">["type"];
  status: "pending";
  createdAt: number;
  reminderScheduledAt?: number;
};

/**
 * Latest `pending` follow-up for an opportunity, sorted by `createdAt` desc.
 *
 * Returns the full document so mutations can inspect every field. Query
 * sites that only need a summary should project via `toActiveFollowUpSummary`.
 */
export async function loadActiveFollowUpDoc(
  ctx: QueryCtx | MutationCtx,
  opportunityId: Id<"opportunities">,
): Promise<Doc<"followUps"> | null> {
  const followUps = await ctx.db
    .query("followUps")
    .withIndex("by_opportunityId_and_status", (q) =>
      q.eq("opportunityId", opportunityId).eq("status", "pending"),
    )
    .take(50);

  return followUps.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}

/**
 * Project a follow-up doc to the lightweight summary shape that UI needs.
 *
 * The summary exposes only what the admin review surface and the closer
 * meeting detail page actually render, avoiding leaking tenant-internal
 * fields into the client payload.
 */
export function toActiveFollowUpSummary(
  followUp: Doc<"followUps"> | null,
): ActiveFollowUpSummary | null {
  if (!followUp) return null;
  return {
    _id: followUp._id,
    type: followUp.type,
    status: "pending",
    createdAt: followUp.createdAt,
    reminderScheduledAt: followUp.reminderScheduledAt,
  };
}

/**
 * Convenience for query sites that want the summary directly.
 */
export async function loadActiveFollowUpSummary(
  ctx: QueryCtx | MutationCtx,
  opportunityId: Id<"opportunities">,
): Promise<ActiveFollowUpSummary | null> {
  return toActiveFollowUpSummary(await loadActiveFollowUpDoc(ctx, opportunityId));
}
