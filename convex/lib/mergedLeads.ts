import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

// A person rarely absorbs more than a handful of leads; the walk stops here.
export const MERGED_SOURCE_LIMIT = 20;

/**
 * The person and every lead merged into them, following earlier merges too:
 * a merge doesn't repoint the history rows of leads merged into its source.
 */
export async function mergedLeadIds(
  ctx: QueryCtx | MutationCtx,
  tenantId: Id<"tenants">,
  leadId: Id<"leads">,
): Promise<Id<"leads">[]> {
  const leadIds: Id<"leads">[] = [leadId];
  for (let index = 0; index < leadIds.length && leadIds.length < MERGED_SOURCE_LIMIT; index += 1) {
    const merges = await ctx.db
      .query("leadMergeHistory")
      .withIndex("by_targetLeadId", (q) => q.eq("targetLeadId", leadIds[index]))
      .take(MERGED_SOURCE_LIMIT);
    for (const merge of merges) {
      if (merge.tenantId === tenantId && !leadIds.includes(merge.sourceLeadId) && leadIds.length < MERGED_SOURCE_LIMIT) {
        leadIds.push(merge.sourceLeadId);
      }
    }
  }
  return leadIds;
}
