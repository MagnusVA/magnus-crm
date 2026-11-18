import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { automationTables } from "../automation/schema";
import { leadDisplayFromShape } from "../lib/leadDisplay";
import { paymentCommandRefusalValidator, refuse } from "../payments/commandResult";
import { requireTenantUser } from "../requireTenantUser";

export const listMyPinnedLines = query({
  args: {},
  returns: v.array(v.object({
    ...automationTables.closerPinnedLines.validator.fields,
    _id: v.id("closerPinnedLines"),
    _creationTime: v.number(),
    leadId: v.union(v.id("leads"), v.null()),
    personName: v.union(v.string(), v.null()),
  })),
  handler: async (ctx) => {
    const { tenantId, userId } = await requireTenantUser(ctx, ["closer"]);
    const lines = await ctx.db.query("closerPinnedLines")
      .withIndex("by_tenantId_and_userId_and_dismissedAt_and_createdAt", (q) =>
        q.eq("tenantId", tenantId).eq("userId", userId).eq("dismissedAt", undefined))
      .order("desc").take(20);
    return await Promise.all(lines.map(async (line) => {
      const deal = await ctx.db.get("opportunities", line.opportunityId);
      const lead = deal?.tenantId === tenantId ? await ctx.db.get("leads", deal.leadId) : null;
      return {
        ...line,
        leadId: lead?.tenantId === tenantId ? lead._id : null,
        personName: lead?.tenantId === tenantId
          ? leadDisplayFromShape({ fullName: lead.fullName, leadId: lead._id })
          : null,
      };
    }));
  },
});

export const dismissPinnedLine = mutation({
  args: { lineId: v.id("closerPinnedLines") },
  returns: v.union(paymentCommandRefusalValidator, v.object({ ok: v.literal(true), alreadyApplied: v.boolean() })),
  handler: async (ctx, { lineId }) => {
    const { tenantId, userId } = await requireTenantUser(ctx, ["closer"]);
    const line = await ctx.db.get("closerPinnedLines", lineId);
    if (line?.tenantId !== tenantId || line.userId !== userId) return refuse("not_owner");
    if (line.dismissedAt !== undefined) return { ok: true as const, alreadyApplied: true };
    await ctx.db.patch("closerPinnedLines", lineId, { dismissedAt: Date.now() });
    return { ok: true as const, alreadyApplied: false };
  },
});
