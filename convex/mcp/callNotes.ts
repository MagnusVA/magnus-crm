import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import { requireTenantUser, type TenantUserResult } from "../requireTenantUser";
import { canOpenOpportunityDetail } from "../leadCustomers/permissions";
import { rejectRequest } from "../lib/observability/errors";
import schema from "../schema";

async function requireDeal(
  ctx: QueryCtx,
  me: TenantUserResult,
  opportunityId: Id<"opportunities">,
) {
  const opportunity = await ctx.db.get("opportunities", opportunityId);
  if (
    !opportunity ||
    opportunity.tenantId !== me.tenantId ||
    !canOpenOpportunityDetail({
      viewerUserId: me.userId,
      viewerRole: me.role,
      opportunity,
    })
  ) {
    throw rejectRequest("call_note.not_yours", "That isn't one of your deals.");
  }
}
export const getForDeal = query({
  args: { opportunityId: v.id("opportunities") },
  returns: v.object({
    notes: v.array(schema.doc("callNotes")),
    isPartial: v.boolean(),
  }),
  handler: async (ctx, { opportunityId }) => {
    const me = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);
    await requireDeal(ctx, me, opportunityId);
    const notes = await ctx.db
      .query("callNotes")
      .withIndex("by_tenantId_and_opportunityId_and_createdAt", (q) =>
        q.eq("tenantId", me.tenantId).eq("opportunityId", opportunityId),
      )
      .order("desc")
      .take(51);
    return { notes: notes.slice(0, 50), isPartial: notes.length > 50 };
  },
});
export const getForEvent = query({
  args: { eventId: v.id("domainEvents") },
  returns: v.union(schema.doc("callNotes"), v.null()),
  handler: async (ctx, { eventId }) => {
    const me = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);
    const event = await ctx.db.get("domainEvents", eventId);
    if (
      !event ||
      event.tenantId !== me.tenantId ||
      event.eventType !== "opportunity.call_note_added"
    )
      return null;
    const metadata: unknown = event.metadata
      ? JSON.parse(event.metadata)
      : null;
    const value =
      metadata && typeof metadata === "object" && "callNoteId" in metadata
        ? metadata.callNoteId
        : null;
    const id =
      typeof value === "string" ? ctx.db.normalizeId("callNotes", value) : null;
    const note = id ? await ctx.db.get("callNotes", id) : null;
    if (!note || note.tenantId !== me.tenantId) return null;
    // The note may have moved with its meeting since the event was emitted.
    const opportunity = await ctx.db.get("opportunities", note.opportunityId);
    if (
      !opportunity ||
      opportunity.tenantId !== me.tenantId ||
      !canOpenOpportunityDetail({
        viewerUserId: me.userId,
        viewerRole: me.role,
        opportunity,
      })
    )
      return null;
    return note;
  },
});
