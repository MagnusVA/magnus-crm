import { v } from "convex/values";
import type { Id } from "../../../_generated/dataModel";
import { internalQuery, type QueryCtx } from "../../../_generated/server";
import { readLiveQueryRows } from "../../../lib/liveQueryBounds";
import { getTenantBusinessDay } from "../../../lib/tenantBusinessDay";
import { addBusinessDays, businessDayStart, calendarDate, businessDateForInstant } from "../../../../lib/businessDay";
import { mcpCallerValidator, requireMcpAdmin, loadInTenant, normalizeMcpId } from "../../guard";
import { rejectRequest } from "../../../lib/observability/errors";
import { formatLocal } from "../../time";
import {
  answerBytes,
  type Admin,
  text,
  textValidator,
  paths,
  partialReason,
  fitRows,
} from "./common";

export const endOfDayArgs = {
  date: v.string(),
  closerId: v.optional(v.string()),
  includeNarrative: v.optional(v.boolean()),
};
const reportValidator = v.object({
  reportId: v.id("endOfDayReports"),
  savedAt: v.string(),
  calls: v.number(),
  won: v.number(),
  gaps: v.array(v.object({ kind: v.string(), label: textValidator })),
  slackStatus: v.string(),
  agentClient: v.union(v.string(), v.null()),
  narrative: v.optional(textValidator),
  note: v.optional(textValidator),
});
export const endOfDayRowValidator = v.object({
  closerId: v.id("users"),
  name: textValidator,
  status: v.string(),
  calls: v.union(v.number(), v.null()),
  won: v.union(v.number(), v.null()),
  reports: v.array(reportValidator),
  allowedActions: v.array(v.string()),
  openInMagnus: v.string(),
});
export async function buildEndOfDay(
  ctx: QueryCtx,
  me: Admin,
  args: { date: string; closerId?: Id<"users">; includeNarrative?: boolean },
) {
  const day = await getTenantBusinessDay(ctx, me.tenantId);
  try { calendarDate(args.date); } catch {
    throw rejectRequest("range.invalid", "date must be a real business date in YYYY-MM-DD format.");
  }
  const today = businessDateForInstant(Date.now(), day);
  if (args.date > today) throw rejectRequest("range.invalid", `date is in the future. Today's business date is ${today}.`);
  const start = businessDayStart(args.date, day),
    end = businessDayStart(addBusinessDays(args.date, 1), day);
  if (args.closerId) {
    const closer = await loadInTenant(ctx, me, "users", args.closerId);
    if (closer.role !== "closer") throw rejectRequest("mcp.invalid_closer", "closerId must name a closer in this workspace.");
  }
  const [users, reports] = await Promise.all([
    readLiveQueryRows(
      ctx.db
        .query("users")
        .withIndex("by_tenantId_and_isActive", (q) =>
          q.eq("tenantId", me.tenantId).eq("isActive", true),
        ),
      300,
    ),
    readLiveQueryRows(
      ctx.db
        .query("endOfDayReports")
        .withIndex("by_tenantId_and_periodEnd", (q) =>
          q
            .eq("tenantId", me.tenantId)
            .gte("periodEnd", start)
            .lt("periodEnd", end),
        )
        .order("desc"),
      300,
    ),
  ]);
  const closers = new Map(
    users.rows.filter((u) => u.role === "closer").map((u) => [u._id, u]),
  );
  // Reports from removed closers remain visible, and an explicit inactive closer can be opened.
  for (const id of new Set([
    ...reports.rows.map((r) => r.userId),
    ...(args.closerId ? [args.closerId] : []),
  ])) {
    if (!closers.has(id)) {
      const user = await ctx.db.get("users", id);
      if (user?.tenantId === me.tenantId) closers.set(id, user);
    }
  }
  const selected = [...closers.values()]
    .filter((u) => !args.closerId || u._id === args.closerId)
    .sort((a, b) => a._id.localeCompare(b._id));
  let isPartial = users.capped || reports.capped || selected.length > 25;
  const rows = selected.slice(0, 25).map((user) => {
    const saved = reports.rows.filter((r) => r.userId === user._id);
    isPartial ||= saved.length > 10 || saved.some((r) => r.gaps.length > 10);
    return {
      closerId: user._id,
      name: text(user.fullName ?? "Unnamed closer", "closer"),
      status: saved.length
        ? "Report saved"
        : reports.capped
          ? "Unknown: report read is partial"
          : "No report saved",
      calls: saved.length ? saved.reduce(
        (sum, r) =>
          sum +
          r.numbers.newCalls.scheduled +
          r.numbers.followUpCalls.scheduled,
        0,
      ) : null,
      won: saved.length ? saved.reduce((sum, r) => sum + r.numbers.deals.won, 0) : null,
      reports: saved.slice(0, 10).map((r) => ({
        reportId: r._id,
        savedAt: formatLocal(r.createdAt, me.timeZone),
        calls: r.numbers.newCalls.scheduled + r.numbers.followUpCalls.scheduled,
        won: r.numbers.deals.won,
        gaps: r.gaps
          .slice(0, 10)
          .map((g) => ({ kind: g.kind, label: text(g.label, "closer", 200) })),
        slackStatus: r.slackStatus,
        agentClient: r.agentClient ?? null,
        ...(args.includeNarrative
          ? {
              ...(r.narrativeMarkdown
                ? {
                    narrative: text(
                      r.narrativeMarkdown,
                      r.agentClient !== undefined ? "closer_agent" : "closer",
                      1000,
                    ),
                  }
                : {}),
              ...(r.note
                ? {
                    note: text(
                      r.note,
                      r.agentClient !== undefined ? "closer_agent" : "closer",
                      1000,
                    ),
                  }
                : {}),
            }
          : {}),
      })),
      allowedActions: ["magnus_end_of_day", "magnus_lookup"],
      openInMagnus: paths.team(),
    };
  });
  // Preserve at least one report when a closer saved many large narratives.
  for (const row of rows)
    while (
      row.reports.length > 1 &&
      answerBytes(row) > 16000
    ) {
      row.reports.pop();
      isPartial = true;
    }
  const fitted = fitRows(rows);
  isPartial ||= fitted.capped;
  return {
    date: args.date,
    timeZone: me.timeZone,
    rows: fitted.rows,
    isPartial,
    reason: partialReason(isPartial),
  };
}
/**
 * Every closer's end-of-day status for one business date, for the brief. It
 * reads the day's reports once and never trims, so no closer turns "unknown"
 * because another tool's answer had no room for their row.
 */
export async function endOfDayStatuses(ctx: QueryCtx, me: Admin, date: string) {
  const day = await getTenantBusinessDay(ctx, me.tenantId);
  const start = businessDayStart(date, day),
    end = businessDayStart(addBusinessDays(date, 1), day);
  const reports = await readLiveQueryRows(
    ctx.db
      .query("endOfDayReports")
      .withIndex("by_tenantId_and_periodEnd", (q) =>
        q.eq("tenantId", me.tenantId).gte("periodEnd", start).lt("periodEnd", end),
      ),
    2000,
  );
  const saved = new Set(reports.rows.map((r) => r.userId));
  return {
    statusOf: (closerId: Id<"users">) =>
      saved.has(closerId)
        ? "Report saved"
        : reports.capped
          ? "Unknown: report read is partial"
          : "No report saved",
    isPartial: reports.capped,
  };
}
export const run = internalQuery({
  args: { caller: mcpCallerValidator, ...endOfDayArgs },
  returns: v.object({
    date: v.string(),
    timeZone: v.string(),
    rows: v.array(endOfDayRowValidator),
    isPartial: v.boolean(),
    reason: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, { caller, ...args }) => {
    const me = await requireMcpAdmin(ctx, caller);
    return await buildEndOfDay(ctx, me, { ...args, closerId: args.closerId === undefined ? undefined : normalizeMcpId(ctx, "users", args.closerId, "closerId") });
  },
});
