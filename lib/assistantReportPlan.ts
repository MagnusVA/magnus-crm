import { dashboardRangePlan, resolveAnalyticsRange, type AnalyticsRange, resolveDashboardRange, type ResolvedAnalyticsRange } from "./analyticsRange";
import { addBusinessDays, businessDateForInstant, countBusinessDays, type BusinessDaySetting } from "./businessDay";

export type AssistantRange = AnalyticsRange | { kind: "preset"; preset: "today" | "last_week" | "year_to_date" };
export type SourceWindow = { engine: "convex" | "warehouse"; range: AnalyticsRange; window: ResolvedAnalyticsRange; label: "whole_range" | "history" | "today_live" };
export type SourcePlan = { resolvedRange: ResolvedAnalyticsRange; windows: SourceWindow[] };

/** Server equivalent of dashboardRangePlan + useAnalyticsSource/useAnalyticsReport.
 * Kept free of Convex and React so both runtimes can import it. Pages retain their code.
 */
export function planAssistantSources(args: { range: AssistantRange; day: BusinessDaySetting; now: number; page: string; warehousePages: readonly string[]; reportId?: string; settledThrough?: string }): SourcePlan {
  const today = businessDateForInstant(args.now, args.day);
  const range: AnalyticsRange = args.range.kind === "preset" && ["today", "last_week", "year_to_date"].includes(args.range.preset)
    ? (() => { const dates = resolveDashboardRange({ kind: "preset", preset: args.range.preset }, today); return { kind: "custom" as const, startDate: dates.startBusinessDate, endDateInclusive: dates.endBusinessDateInclusive }; })() : args.range as AnalyticsRange;
  const resolvedRange = resolveAnalyticsRange(range, args.day, args.now);
  const plan = dashboardRangePlan(args.range.kind === "preset" && !("throughYesterday" in args.range && args.range.throughYesterday)
    ? { kind: "preset", preset: args.range.preset }
    : { kind: "custom", startBusinessDate: resolvedRange.startDate, endBusinessDateInclusive: resolvedRange.endDateInclusive }, today, args.settledThrough);
  const window = (engine: SourceWindow["engine"], r: AnalyticsRange, label: SourceWindow["label"]): SourceWindow => ({ engine, range: r, window: resolveAnalyticsRange(r, args.day, args.now), label });
  if (plan.kind === "live" || !args.warehousePages.includes(args.page)) return { resolvedRange, windows: [window("convex", range, "whole_range")] };
  if (plan.kind === "warehouse" || args.reportId === "scorecard.answers") return { resolvedRange, windows: [window("warehouse", plan.range, "whole_range")] };
  return { resolvedRange, windows: [window("warehouse", plan.history, "history"), window("convex", { kind: "custom", startDate: plan.liveStartDate, endDateInclusive: resolvedRange.endDateInclusive }, "today_live")] };
}

/** The exact split-cache match in use-analytics-report.ts, including day rollover. */
export function cachedWindowFits(expected: ResolvedAnalyticsRange, answer: { startDate: string; endDateInclusive: string } | null | undefined) {
  return !!answer && expected.startDate === answer.startDate && expected.endDateInclusive === answer.endDateInclusive;
}

/**
 * A report request Magnus can't answer as asked (a limit, size, term,
 * grouping or filter). The report tool sends it to the agent as a refusal it
 * can read; any other error stays a bug.
 */
export class ReportRequestError extends Error {
  override name = "ReportRequestError";
}

export function reportLimit(limit = 10) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new ReportRequestError("Choose a limit from 1 to 25.");
  return limit;
}

/** Called before any data query. Includes the omitted group in the output budget. */
export function assertReportCells(periods: number, groups: number) {
  if (periods * groups > 60) throw new ReportRequestError("Choose at most 60 period × group cells.");
}
export function rangePeriods(range: ResolvedAnalyticsRange) {
  return countBusinessDays(range.startDate, addBusinessDays(range.endDateInclusive, 1));
}
