import { v } from "convex/values";
import { literals } from "convex-helpers/validators";
import type { Doc, Id } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { meetingDealLabelOf } from "../opportunities/stageLabels";
import { DEAL_POSITIONS } from "../opportunities/stages";

const MAX_TASKS_PER_KIND = 50;

const taskValidator = v.object({
  _id: v.id("followUps"),
  type: literals("manual_reminder", "scheduling_link"),
  reason: literals(
    "closer_initiated",
    "cancellation_follow_up",
    "no_show_follow_up",
    "admin_initiated",
    "overran_review_resolution",
    "stale_opportunity_nudge",
  ),
  contactMethod: v.union(literals("call", "text"), v.null()),
  reminderScheduledAt: v.union(v.number(), v.null()),
  reminderNote: v.union(v.string(), v.null()),
  schedulingLinkUrl: v.union(v.string(), v.null()),
  createdAt: v.number(),
  leadId: v.id("leads"),
  opportunityId: v.id("opportunities"),
  leadName: v.string(),
  leadPhone: v.union(v.string(), v.null()),
  programName: v.union(v.string(), v.null()),
  dealPosition: v.union(literals(...DEAL_POSITIONS), v.null()),
});

/**
 * The closer's open tasks for the Today page: pending reminders, soonest
 * first, and pending scheduling links (the ones waiting on the person to
 * book). Each carries the person's name and phone, and its deal's program and
 * position for the row's second line.
 *
 * Reads at most MAX_TASKS_PER_KIND of each kind; `isPartial` says one kind
 * had more.
 */
export const getCloserTasks = query({
  args: {},
  returns: v.object({
    reminders: v.array(taskValidator),
    schedulingLinks: v.array(taskValidator),
    isPartial: v.boolean(),
  }),
  handler: async (ctx) => {
    const { tenantId, userId } = await requireTenantUser(ctx, ["closer"]);

    const readPending = (type: Doc<"followUps">["type"]) =>
      ctx.db
        .query("followUps")
        .withIndex(
          "by_tenantId_and_closerId_and_type_and_status_reminderScheduledAt",
          (q) =>
            q
              .eq("tenantId", tenantId)
              .eq("closerId", userId)
              .eq("type", type)
              .eq("status", "pending"),
        )
        .take(MAX_TASKS_PER_KIND + 1);

    const [reminderRows, linkRows] = await Promise.all([
      readPending("manual_reminder"),
      readPending("scheduling_link"),
    ]);
    const reminders = reminderRows.slice(0, MAX_TASKS_PER_KIND);
    const links = linkRows.slice(0, MAX_TASKS_PER_KIND);

    const enrich = await taskEnricher(ctx, tenantId, [...reminders, ...links]);
    return {
      reminders: reminders.map(enrich),
      schedulingLinks: links.map(enrich),
      isPartial:
        reminderRows.length > MAX_TASKS_PER_KIND ||
        linkRows.length > MAX_TASKS_PER_KIND,
    };
  },
});

/** Reads each task's person, deal and event type once, then shapes a row. */
async function taskEnricher(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  tasks: Array<Doc<"followUps">>,
) {
  const leadIds = [...new Set(tasks.map((task) => task.leadId))];
  const opportunityIds = [...new Set(tasks.map((task) => task.opportunityId))];
  const [leads, opportunities] = await Promise.all([
    Promise.all(leadIds.map((id) => ctx.db.get("leads", id))),
    Promise.all(opportunityIds.map((id) => ctx.db.get("opportunities", id))),
  ]);
  const leadById = new Map<Id<"leads">, Doc<"leads">>();
  for (const lead of leads) {
    if (lead && lead.tenantId === tenantId) leadById.set(lead._id, lead);
  }
  const opportunityById = new Map<Id<"opportunities">, Doc<"opportunities">>();
  for (const opportunity of opportunities) {
    if (opportunity && opportunity.tenantId === tenantId) {
      opportunityById.set(opportunity._id, opportunity);
    }
  }

  // The event type names the program only when no booking program is mapped.
  const eventTypeConfigIds = [
    ...new Set(
      [...opportunityById.values()]
        .filter((opportunity) => !opportunity.firstBookingProgramName)
        .flatMap((opportunity) =>
          opportunity.eventTypeConfigId ? [opportunity.eventTypeConfigId] : [],
        ),
    ),
  ];
  const eventTypeConfigs = await Promise.all(
    eventTypeConfigIds.map((id) => ctx.db.get("eventTypeConfigs", id)),
  );
  const eventTypeNameById = new Map<Id<"eventTypeConfigs">, string>();
  for (const config of eventTypeConfigs) {
    if (config && config.tenantId === tenantId) {
      eventTypeNameById.set(config._id, config.displayName);
    }
  }

  return (task: Doc<"followUps">) => {
    const lead = leadById.get(task.leadId);
    const opportunity = opportunityById.get(task.opportunityId);
    const programName =
      opportunity?.firstBookingProgramName ??
      (opportunity?.eventTypeConfigId
        ? eventTypeNameById.get(opportunity.eventTypeConfigId)
        : undefined) ??
      null;
    return {
      _id: task._id,
      type: task.type,
      reason: task.reason,
      contactMethod: task.contactMethod ?? null,
      reminderScheduledAt: task.reminderScheduledAt ?? null,
      reminderNote: task.reminderNote ?? null,
      schedulingLinkUrl: task.schedulingLinkUrl ?? null,
      createdAt: task.createdAt,
      leadId: task.leadId,
      opportunityId: task.opportunityId,
      leadName: lead?.fullName ?? lead?.email ?? "Unknown",
      leadPhone: lead?.phone ?? null,
      programName,
      dealPosition: opportunity ? meetingDealLabelOf(opportunity).dealPosition : null,
    };
  };
}
