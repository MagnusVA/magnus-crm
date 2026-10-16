import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import {
  moveMeetingToOpportunity,
  moveOpportunityToLead,
} from "../leads/repointLeadReferences";
import { emitDomainEvent } from "../lib/domainEvents";
import { leadDisplayString } from "../lib/leadDisplay";
import { log } from "../lib/observability/log";
import {
  patchOpportunityLifecycle,
  transitionOpportunity,
  type OpportunityFieldsPatch,
} from "../lib/opportunityActivity";
import { updateOpportunityMeetingRefs } from "../lib/opportunityMeetingRefs";
import { refreshOpportunitySearchForLead } from "../lib/opportunitySearch";
import type { OpportunityStatus } from "../lib/statusTransitions";
import { syncCustomerSnapshot } from "../lib/syncCustomerSnapshot";
import { syncLeadMeetingNames } from "../lib/syncLeadMeetingNames";
import { isActiveOpportunityStatus, updateTenantStats } from "../lib/tenantStatsHelper";
import {
  rebuildQualificationRow,
  rebuildQualificationRowsForOpportunity,
} from "../operations/projections";
import { leadTimeline } from "../reporting/aggregates";
import { deleteOpportunityAggregate, replaceMeetingAggregate } from "../reporting/writeHooks";
import { readPlanPersons } from "./apply";
import { restoredFields } from "./audit";
import { leadSplitPlanStatusValidator } from "./schema";

// Rollback (docs/plans/polluted-lead-split.md §5.9). Undoes a plan's audit
// rows newest first, across all its persons, so each row finds the state
// its write left. Domain events stay: they record what happened.

const DEFAULT_BATCH_SIZE = 25;
const AUDIT_ROW_LIMIT = 5000;
const ROLLBACK_STATUSES: ReadonlySet<Doc<"leadSplitPlans">["status"]> = new Set([
  "applying",
  "applied",
  "failed",
] as const);

type Touched = { leads: Set<Id<"leads">>; opportunities: Set<Id<"opportunities">> };

/**
 * A lead the plan created can only be deleted while it holds nothing but
 * what the plan put there. Checked before the first row is undone, so a
 * booking that landed on a new lead stops the rollback before it starts.
 */
async function checkNothingNewAttached(ctx: MutationCtx, plan: Doc<"leadSplitPlans">) {
  const rows = await ctx.db
    .query("leadSplitAudit")
    .withIndex("by_planId_and_revertedAt", (q) => q.eq("planId", plan._id))
    .take(AUDIT_ROW_LIMIT);
  const planned = new Set(
    rows.filter((row) => row.table === "opportunities").map((row) => row.docId),
  );
  for (const row of rows) {
    if (row.table !== "leads" || row.op !== "insert") continue;
    const opportunities = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_leadId", (q) =>
        q.eq("tenantId", plan.tenantId).eq("leadId", row.docId as Id<"leads">),
      )
      .take(100);
    const unplanned = opportunities.find((opportunity) => !planned.has(opportunity._id));
    if (unplanned) {
      throw new Error(
        `Opportunity ${unplanned._id} was added to new lead ${row.docId} after the split. Move it before rolling back.`,
      );
    }
  }
}

async function revertRow(ctx: MutationCtx, plan: Doc<"leadSplitPlans">, row: Doc<"leadSplitAudit">, touched: Touched) {
  const { tenantId } = plan;
  if (row.table === "leads" && row.op === "insert") {
    const leadId = row.docId as Id<"leads">;
    const lead = await ctx.db.get("leads", leadId);
    if (!lead) return;
    const [opportunity, identifier] = await Promise.all([
      ctx.db
        .query("opportunities")
        .withIndex("by_tenantId_and_leadId", (q) => q.eq("tenantId", tenantId).eq("leadId", leadId))
        .first(),
      ctx.db
        .query("leadIdentifiers")
        .withIndex("by_leadId", (q) => q.eq("leadId", leadId))
        .first(),
    ]);
    if (opportunity || identifier) {
      throw new Error(`Lead ${leadId} still has ${opportunity ? "opportunities" : "identifiers"}`);
    }
    // `leadTimeline` has no delete hook in writeHooks.ts.
    await leadTimeline.deleteIfExists(ctx, lead);
    await ctx.db.delete("leads", leadId);
    const searchRow = await ctx.db
      .query("leadCustomerSearchRows")
      .withIndex("by_tenantId_and_leadId", (q) => q.eq("tenantId", tenantId).eq("leadId", leadId))
      .unique();
    if (searchRow) await ctx.db.delete("leadCustomerSearchRows", searchRow._id);
    if (lead.status === "active") await updateTenantStats(ctx, tenantId, { totalLeads: -1 });
    touched.leads.delete(leadId);
    return;
  }

  if (row.table === "opportunities" && row.op === "insert") {
    const opportunityId = row.docId as Id<"opportunities">;
    const opportunity = await ctx.db.get("opportunities", opportunityId);
    if (!opportunity) return;
    const [meeting, followUp, event] = await Promise.all([
      ctx.db
        .query("meetings")
        .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunityId))
        .first(),
      ctx.db
        .query("followUps")
        .withIndex("by_opportunityId_and_status_and_reason", (q) => q.eq("opportunityId", opportunityId))
        .first(),
      ctx.db
        .query("slackQualificationEvents")
        .withIndex("by_tenantId_and_opportunityId", (q) =>
          q.eq("tenantId", tenantId).eq("opportunityId", opportunityId),
        )
        .first(),
    ]);
    if (meeting || followUp || event) {
      throw new Error(`Opportunity ${opportunityId} still has rows pointing at it`);
    }
    await deleteOpportunityAggregate(ctx, opportunity);
    await ctx.db.delete("opportunities", opportunityId);
    // The counters follow the status the opportunity has now.
    await updateTenantStats(ctx, tenantId, {
      totalOpportunities: -1,
      activeOpportunities: isActiveOpportunityStatus(opportunity.status) ? -1 : 0,
      wonDeals: opportunity.status === "payment_received" ? -1 : 0,
      lostDeals: opportunity.status === "lost" ? -1 : 0,
    });
    touched.opportunities.delete(opportunityId);
    touched.leads.add(opportunity.leadId);
    return;
  }

  const restore = restoredFields(row);
  if (row.table === "meetings" && row.op === "patch") {
    const meetingId = row.docId as Id<"meetings">;
    const meeting = await ctx.db.get("meetings", meetingId);
    if (!meeting) return;
    const { opportunityId, leadName, ...fields } = restore as Partial<Doc<"meetings">>;
    if (opportunityId && opportunityId !== meeting.opportunityId) {
      touched.opportunities.add(meeting.opportunityId);
      touched.opportunities.add(opportunityId);
      await moveMeetingToOpportunity(ctx, {
        tenantId,
        meetingId,
        toOpportunityId: opportunityId,
        leadName: leadName ?? meeting.leadName ?? "",
        fields,
      });
    } else {
      await ctx.db.patch("meetings", meetingId, fields);
      await replaceMeetingAggregate(ctx, meeting, meetingId);
      touched.opportunities.add(meeting.opportunityId);
    }
    return;
  }

  if (row.table === "opportunities" && row.op === "patch") {
    const opportunityId = row.docId as Id<"opportunities">;
    const opportunity = await ctx.db.get("opportunities", opportunityId);
    if (!opportunity) return;
    touched.opportunities.add(opportunityId);
    if (row.step.startsWith("move:")) {
      const toLeadId = restore.leadId as Id<"leads">;
      const lead = await ctx.db.get("leads", toLeadId);
      if (!lead) throw new Error(`Lead ${toLeadId} is gone`);
      touched.leads.add(opportunity.leadId);
      touched.leads.add(toLeadId);
      await moveOpportunityToLead(ctx, {
        tenantId,
        opportunityId,
        toLeadId,
        leadName: leadDisplayString(lead),
        now: Date.now(),
        moveFormResponses: true,
      });
      return;
    }
    const { status, ...fields } = restore as OpportunityFieldsPatch & { status?: OpportunityStatus };
    if (status && status !== opportunity.status) {
      await transitionOpportunity(ctx, opportunityId, {
        to: status,
        fields,
        source: "system",
        exception: "lead_split_rollback",
        reason: "lead_split_rollback",
        metadata: { planId: plan._id },
      });
    } else if (Object.keys(fields).length > 0) {
      await patchOpportunityLifecycle(ctx, opportunityId, fields);
    }
    return;
  }

  if (row.table === "leadIdentifiers" && row.op === "patch") {
    const identifierId = row.docId as Id<"leadIdentifiers">;
    const identifier = await ctx.db.get("leadIdentifiers", identifierId);
    if (!identifier) return;
    const leadId = restore.leadId as Id<"leads">;
    touched.leads.add(identifier.leadId);
    touched.leads.add(leadId);
    await ctx.db.patch("leadIdentifiers", identifierId, { leadId });
    return;
  }

  if (row.table === "leadIdentifiers" && row.op === "delete") {
    // The re-inserted identifier gets a new ID.
    const before = row.before as Omit<Doc<"leadIdentifiers">, "_id" | "_creationTime">;
    await ctx.db.insert("leadIdentifiers", before);
    touched.leads.add(before.leadId);
    return;
  }

  if (row.table === "slackQualificationEvents" && row.op === "patch") {
    const eventId = row.docId as Id<"slackQualificationEvents">;
    if (!(await ctx.db.get("slackQualificationEvents", eventId))) return;
    await ctx.db.patch("slackQualificationEvents", eventId, restore as Partial<Doc<"slackQualificationEvents">>);
    await rebuildQualificationRow(ctx, eventId);
    return;
  }

  if (row.table === "leads" && row.op === "patch") {
    const leadId = row.docId as Id<"leads">;
    if (!(await ctx.db.get("leads", leadId))) return;
    await ctx.db.patch("leads", leadId, restore as Partial<Doc<"leads">>);
    touched.leads.add(leadId);
    return;
  }

  throw new Error(`Rollback can't undo ${row.op} on ${row.table} (audit row ${row._id})`);
}

/**
 * Undoes up to `batchSize` of a plan's audit rows, newest first, then
 * schedules itself until none are left. The last call resets the plan's
 * persons and marks it `rolled_back`, from where it can be rebuilt.
 */
export const rollbackPlan = internalMutation({
  args: {
    planId: v.id("leadSplitPlans"),
    batchSize: v.optional(v.number()),
  },
  returns: v.object({
    planId: v.id("leadSplitPlans"),
    reverted: v.number(),
    continues: v.boolean(),
    status: leadSplitPlanStatusValidator,
  }),
  handler: async (ctx, args) => {
    const plan = await ctx.db.get("leadSplitPlans", args.planId);
    if (!plan) throw new Error("Lead split plan not found");
    if (plan.status === "rolled_back") {
      return { planId: plan._id, reverted: 0, continues: false, status: plan.status };
    }
    if (!ROLLBACK_STATUSES.has(plan.status)) {
      throw new Error(`A ${plan.status} plan has nothing to roll back`);
    }
    const startedAlready = await ctx.db
      .query("leadSplitAudit")
      .withIndex("by_planId_and_revertedAt", (q) => q.eq("planId", plan._id).gt("revertedAt", 0))
      .first();
    if (!startedAlready) await checkNothingNewAttached(ctx, plan);

    const batchSize = Math.max(1, Math.min(args.batchSize ?? DEFAULT_BATCH_SIZE, 100));
    const rows = await ctx.db
      .query("leadSplitAudit")
      .withIndex("by_planId_and_revertedAt", (q) => q.eq("planId", plan._id).eq("revertedAt", undefined))
      .order("desc")
      .take(batchSize + 1);
    const batch = rows.slice(0, batchSize);
    const now = Date.now();
    const touched: Touched = { leads: new Set(), opportunities: new Set() };
    for (const row of batch) {
      await revertRow(ctx, plan, row, touched);
      await ctx.db.patch("leadSplitAudit", row._id, { revertedAt: now });
    }

    for (const opportunityId of touched.opportunities) {
      if (!(await ctx.db.get("opportunities", opportunityId))) continue;
      await updateOpportunityMeetingRefs(ctx, opportunityId);
      await rebuildQualificationRowsForOpportunity(ctx, opportunityId);
    }
    for (const leadId of touched.leads) {
      const lead = await ctx.db.get("leads", leadId);
      if (!lead) continue;
      const identifiers = await ctx.db
        .query("leadIdentifiers")
        .withIndex("by_leadId", (q) => q.eq("leadId", leadId))
        .take(200);
      await refreshOpportunitySearchForLead(ctx, plan.tenantId, leadId);
      await syncLeadMeetingNames(ctx, plan.tenantId, leadId, leadDisplayString(lead, identifiers));
      await syncCustomerSnapshot(ctx, plan.tenantId, leadId);
    }

    const continues = rows.length > batchSize;
    if (continues) {
      await ctx.scheduler.runAfter(0, internal.leadSplit.rollback.rollbackPlan, args);
      log.info("lead_split.rollback.batch", { tenantId: plan.tenantId, planId: plan._id, reverted: batch.length });
      return { planId: plan._id, reverted: batch.length, continues, status: plan.status };
    }

    for (const person of await readPlanPersons(ctx, plan._id)) {
      await ctx.db.patch("leadSplitPersons", person._id, {
        status: "pending",
        extractedAt: undefined,
        ...(person.role === "new" ? { targetLeadId: undefined } : {}),
        opportunityPlan: person.opportunityPlan.map(({ newOpportunityId: _, ...entry }) => entry),
      });
    }
    await ctx.db.patch("leadSplitPlans", plan._id, { status: "rolled_back", updatedAt: now });
    await emitDomainEvent(ctx, {
      tenantId: plan.tenantId,
      entityType: "lead",
      entityId: plan.sourceLeadId,
      eventType: "lead.split_rolled_back",
      source: "system",
      metadata: { planId: plan._id },
      occurredAt: now,
    });
    log.info("lead_split.rollback.done", { tenantId: plan.tenantId, planId: plan._id, reverted: batch.length });
    return { planId: plan._id, reverted: batch.length, continues, status: "rolled_back" as const };
  },
});
