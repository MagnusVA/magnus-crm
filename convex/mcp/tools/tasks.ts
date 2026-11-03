import { v, type Infer } from "convex/values";
import { internalQuery } from "../../_generated/server";
import { readCloserTasks } from "../../closer/followUpQueries";
import { getTenantBusinessDay } from "../../lib/tenantBusinessDay";
import {
  businessDateForInstant,
  businessDayRange,
} from "../../../lib/businessDay";
import { mcpCallerValidator, requireMcpUser } from "../guard";
import { formatLocal } from "../time";

const taskValidator = v.object({
  taskId: v.id("followUps"),
  opportunityId: v.id("opportunities"),
  personId: v.id("leads"),
  person: v.object({ text: v.string(), personSupplied: v.literal(true) }),
  kind: v.string(),
  due: v.union(v.string(), v.null()),
  note: v.union(
    v.object({ text: v.string(), personSupplied: v.literal(true) }),
    v.null(),
  ),
});
export const run = internalQuery({
  args: { caller: mcpCallerValidator },
  returns: v.object({
    timeZone: v.string(),
    businessDay: v.string(),
    overdue: v.array(taskValidator),
    today: v.array(taskValidator),
    later: v.array(taskValidator),
    isPartial: v.boolean(),
  }),
  handler: async (ctx, { caller }) => {
    const me = await requireMcpUser(ctx, caller, ["closer"]);
    const tasks = await readCloserTasks(ctx, me.tenantId, me.userId);
    const setting = await getTenantBusinessDay(ctx, me.tenantId);
    const day = businessDateForInstant(Date.now(), setting);
    const { start, end } = businessDayRange(day, setting);
    const groups: Record<
      "overdue" | "today" | "later",
      Array<Infer<typeof taskValidator>>
    > = { overdue: [], today: [], later: [] };
    for (const task of [...tasks.reminders, ...tasks.schedulingLinks]) {
      const due = task.reminderScheduledAt;
      const group =
        due === null || due >= end
          ? "later"
          : due < start
            ? "overdue"
            : "today";
      const lead = await ctx.db.get("leads", task.leadId);
      groups[group].push({
        taskId: task._id,
        opportunityId: task.opportunityId,
        personId: task.leadId,
        person: {
          text:
            lead?.tenantId === me.tenantId
              ? (lead.fullName ?? "Unknown person")
              : "Unknown person",
          personSupplied: true,
        },
        kind:
          task.type === "scheduling_link"
            ? "scheduling_link"
            : (task.contactMethod ?? "call"),
        due: due === null ? null : formatLocal(due, me.timeZone),
        note: task.reminderNote
          ? { text: task.reminderNote, personSupplied: true }
          : null,
      });
    }
    return {
      timeZone: me.timeZone,
      businessDay: day,
      ...groups,
      isPartial: tasks.isPartial,
    };
  },
});
