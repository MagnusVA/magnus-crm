import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export async function syncCustomerSnapshot(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  leadId: Id<"leads">,
): Promise<void> {
  const lead = await ctx.db.get(leadId);
  if (!lead || lead.tenantId !== tenantId) {
    return;
  }

  const customer = await ctx.db
    .query("customers")
    .withIndex("by_tenantId_and_leadId", (q) =>
      q.eq("tenantId", tenantId).eq("leadId", leadId),
    )
    .unique();

  if (!customer) {
    return;
  }

  await ctx.db.patch(customer._id, {
    fullName: lead.fullName ?? lead.email,
    email: lead.email,
    phone: lead.phone,
    socialHandles: lead.socialHandles,
  });
}
