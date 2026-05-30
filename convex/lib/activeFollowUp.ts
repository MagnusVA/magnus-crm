import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

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
 * The summary exposes only what the closer meeting detail page renders,
 * avoiding leaking tenant-internal fields into the client payload.
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
