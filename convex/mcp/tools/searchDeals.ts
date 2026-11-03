import { v } from "convex/values";
import { internalQuery } from "../../_generated/server";
import { buildMyOpportunities, tabValidator } from "../../closer/pipeline";
import { mcpCallerValidator, requireMcpUser } from "../guard";
import { financingProviderValidator } from "../schema";
import {
  latestCallNote,
  noteResult,
  noteResultValidator,
  personText,
  personTextValidator,
} from "../noteRead";
import { formatLocal } from "../time";

export const searchDealArgs = {
  tab: v.optional(tabValidator),
  programKey: v.optional(v.string()),
  search: v.optional(v.string()),
  state: v.optional(v.union(v.literal("no_step"), v.literal("not_recorded"))),
  financingProvider: v.optional(financingProviderValidator),
  limit: v.optional(v.number()),
};
export const run = internalQuery({
  args: { caller: mcpCallerValidator, ...searchDealArgs },
  returns: v.object({
    timeZone: v.string(),
    isPartial: v.boolean(),
    matched: v.number(),
    deals: v.array(
      v.object({
        opportunityId: v.id("opportunities"),
        personId: v.id("leads"),
        person: personTextValidator,
        programKey: v.string(),
        program: v.union(v.string(), v.null()),
        position: v.string(),
        lastActivity: v.string(),
        nextStep: v.union(v.string(), v.null()),
        latestCallNote: v.union(noteResultValidator, v.null()),
      }),
    ),
  }),
  handler: async (ctx, { caller, ...args }) => {
    const me = await requireMcpUser(ctx, caller, ["closer"]);
    const result = await buildMyOpportunities(ctx, me, {
      ...args,
      tab: args.tab ?? "all",
      limit: Math.max(1, Math.min(50, args.limit ?? 25)),
    });
    const deals = await Promise.all(
      result.rows.map(async (row) => {
        const [lead, note] = await Promise.all([
          ctx.db.get("leads", row.leadId),
          latestCallNote(ctx, me.tenantId, row.opportunityId),
        ]);
        const next = row.nextStep;
        const nextStep =
          next?.callAt && next.callAt > Date.now()
            ? `Call ${formatLocal(next.callAt, me.timeZone)}`
            : next?.task?.kind === "task"
              ? `${next.task.method}${next.task.dueAt === null ? "" : ` ${formatLocal(next.task.dueAt, me.timeZone)}`}`
              : next?.task?.kind === "link"
                ? "Waiting for the person to book"
                : null;
        return {
          opportunityId: row.opportunityId,
          personId: row.leadId,
          person: personText(
            lead?.tenantId === me.tenantId
              ? (lead.fullName ?? "Unknown person")
              : "Unknown person",
          ),
          programKey: row.programKey,
          program: row.programName,
          position: row.position,
          lastActivity: formatLocal(row.lastActivityAt, me.timeZone),
          nextStep,
          latestCallNote: note ? noteResult(note, me.timeZone) : null,
        };
      }),
    );
    return {
      timeZone: me.timeZone,
      isPartial:
        result.isPartial ||
        result.isSearchPartial ||
        result.matched > result.rows.length,
      matched: result.matched,
      deals,
    };
  },
});
