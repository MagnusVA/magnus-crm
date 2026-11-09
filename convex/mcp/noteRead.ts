import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { financingProviderValidator } from "./schema";
import { formatLocal } from "./time";

export const personTextValidator = v.object({
  text: v.string(),
  personSupplied: v.literal(true),
});
export const personText = (text: string) => ({
  text,
  personSupplied: true as const,
});
export const noteResultValidator = v.object({
  callNoteId: v.id("callNotes"),
  at: v.string(),
  via: v.string(),
  personSupplied: v.literal(true),
  currentSituation: v.string(),
  goal: v.string(),
  bottleneck: v.string(),
  objection: v.string(),
  nextAction: v.union(v.string(), v.null()),
  financingProvider: v.union(financingProviderValidator, v.null()),
});
export function noteResult(note: Doc<"callNotes">, timeZone: string) {
  return {
    callNoteId: note._id,
    at: formatLocal(note.createdAt, timeZone),
    via: note.agentClient,
    personSupplied: true as const,
    currentSituation: note.currentSituation,
    goal: note.goal,
    bottleneck: note.bottleneck,
    objection: note.objection,
    nextAction: note.nextAction ?? null,
    financingProvider: note.financingProvider ?? null,
  };
}
export async function latestCallNote(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  opportunityId: Id<"opportunities">,
) {
  return await ctx.db
    .query("callNotes")
    .withIndex("by_tenantId_and_opportunityId_and_createdAt", (q) =>
      q.eq("tenantId", tenantId).eq("opportunityId", opportunityId),
    )
    .order("desc")
    .first();
}
