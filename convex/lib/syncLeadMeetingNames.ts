import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export async function syncLeadMeetingNames(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  leadId: Id<"leads">,
  leadName: string,
): Promise<number> {
  let updatedCount = 0;

  for await (const opportunity of ctx.db
    .query("opportunities")
    .withIndex("by_tenantId_and_leadId", (q) =>
      q.eq("tenantId", tenantId).eq("leadId", leadId),
    )) {
    for await (const meeting of ctx.db
      .query("meetings")
      .withIndex("by_opportunityId", (q) =>
        q.eq("opportunityId", opportunity._id),
      )) {
      if (meeting.leadName === leadName) {
        continue;
      }

      await ctx.db.patch(meeting._id, { leadName });
      updatedCount += 1;
    }
  }

  return updatedCount;
}
