import { makeFunctionReference } from "convex/server";
import { v, type ObjectType } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { OUTSTANDING_DECISION_STATES } from "./humanResult";

const PAGE_SIZE = 100;
const outstandingState = v.union(v.literal("ready"), v.literal("needs_person"), v.literal("blocked"));
const continueArgs = {
  tenantId: v.id("tenants"),
  leadId: v.id("leads"),
  actorUserId: v.id("users"),
  state: outstandingState,
  through: v.number(),
  stopCode: v.union(v.literal("merged"), v.literal("human_result")),
  now: v.number(),
};
type DecisionPage = ObjectType<typeof continueArgs>;

const continueStandDown = makeFunctionReference<"mutation", DecisionPage>(
  "automation/mergeStandDown:continueDecisionStandDown",
);

function outstandingForPerson(ctx: MutationCtx, args: Pick<DecisionPage, "tenantId" | "leadId" | "state">) {
  return ctx.db.query("resultAutomationDecisions")
    .withIndex("by_tenantId_and_leadId_and_state", (q) =>
      q.eq("tenantId", args.tenantId).eq("leadId", args.leadId).eq("state", args.state));
}

async function standDownPage(ctx: MutationCtx, args: DecisionPage, rows: Doc<"resultAutomationDecisions">[]) {
  for (const row of rows.slice(0, PAGE_SIZE)) {
    await ctx.db.patch("resultAutomationDecisions", row._id, {
      state: args.stopCode === "merged" ? "superseded" : "stopped",
      stopCode: args.stopCode,
      resolvedAt: args.now,
      resolvedByUserId: args.actorUserId,
    });
  }
  if (rows.length > PAGE_SIZE) await ctx.scheduler.runAfter(0, continueStandDown, args);
}

export const continueDecisionStandDown = internalMutation({
  args: continueArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("resultAutomationDecisions")
      .withIndex("by_tenantId_and_leadId_and_state", (q) =>
        q.eq("tenantId", args.tenantId).eq("leadId", args.leadId)
          .eq("state", args.state).lte("_creationTime", args.through))
      .take(PAGE_SIZE + 1);
    await standDownPage(ctx, args, rows);
    return null;
  },
});

type ActorAndPeople = {
  tenantId: Id<"tenants">;
  leadIds: Iterable<Id<"leads">>;
  actorUserId: Id<"users">;
};

async function standDownForPeople(
  ctx: MutationCtx,
  { tenantId, leadIds, actorUserId }: ActorAndPeople,
  stopCode: DecisionPage["stopCode"],
) {
  const now = Date.now();
  for (const leadId of new Set(leadIds)) {
    for (const state of OUTSTANDING_DECISION_STATES) {
      const query = outstandingForPerson(ctx, { tenantId, leadId, state });
      const rows = await query.take(PAGE_SIZE + 1);
      if (rows.length === 0) continue;
      const last = rows.length > PAGE_SIZE ? await outstandingForPerson(ctx, { tenantId, leadId, state }).order("desc").first() : null;
      await standDownPage(ctx, {
        tenantId, leadId, state, actorUserId, stopCode, now,
        // The continuation only handles decisions that existed at the time of the change.
        through: last?._creationTime ?? rows[rows.length - 1]._creationTime,
      }, rows);
    }
  }
}

export async function standDownForMerge(ctx: MutationCtx, args: ActorAndPeople): Promise<void> {
  await standDownForPeople(ctx, args, "merged");
}

/** A held review without a deal can still settle outstanding identity decisions. */
export async function standDownForIdentityReview(ctx: MutationCtx, args: ActorAndPeople): Promise<void> {
  await standDownForPeople(ctx, args, "human_result");
}
