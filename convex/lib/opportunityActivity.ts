import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { replaceOpportunityAggregate } from "../reporting/writeHooks";

type ActivityShape = Pick<
  Doc<"opportunities">,
  "paymentReceivedAt" | "lostAt" | "latestMeetingAt" | "updatedAt" | "createdAt"
>;

export function computeLatestActivityAt(opportunity: ActivityShape): number {
  return Math.max(
    opportunity.paymentReceivedAt ?? 0,
    opportunity.lostAt ?? 0,
    opportunity.latestMeetingAt ?? 0,
    opportunity.updatedAt,
    opportunity.createdAt,
  );
}

export async function patchOpportunityLifecycle(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
  patch: Partial<Doc<"opportunities">>,
): Promise<Doc<"opportunities">> {
  const before = await ctx.db.get(opportunityId);
  if (!before) {
    throw new Error("Opportunity not found");
  }

  const updatedAt = patch.updatedAt ?? Date.now();
  const nextShape = { ...before, ...patch, updatedAt };
  await ctx.db.patch(opportunityId, {
    ...patch,
    updatedAt,
    latestActivityAt: computeLatestActivityAt(nextShape),
  });

  if (
    patch.status !== undefined ||
    patch.latestMeetingId !== undefined ||
    patch.nextMeetingId !== undefined ||
    patch.paymentReceivedAt !== undefined ||
    patch.lostAt !== undefined
  ) {
    return await replaceOpportunityAggregate(ctx, before, opportunityId);
  }

  const after = await ctx.db.get(opportunityId);
  if (!after) {
    throw new Error("Opportunity not found after patch");
  }
  return after;
}
