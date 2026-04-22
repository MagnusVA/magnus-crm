import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";

type TeamPerformanceMetrics = FunctionReturnType<
  typeof api.reporting.teamPerformance.getTeamPerformanceMetrics
>;
type TeamOutcomeMixMetrics = FunctionReturnType<
  typeof api.reporting.teamOutcomes.getTeamOutcomeMix
>;

export type OutcomeKey = keyof TeamOutcomeMixMetrics["teamOutcome"];
export type CallMetrics = TeamPerformanceMetrics["closers"][number]["newCalls"];
export type MeetingTimeKpis =
  TeamPerformanceMetrics["closers"][number]["meetingTime"];
export type CloserData = TeamPerformanceMetrics["closers"][number];
export type TeamTotals = TeamPerformanceMetrics["teamTotals"];
export type DerivedOutcomes = TeamOutcomeMixMetrics["derived"];
export type ActionsPerCloserMetrics = FunctionReturnType<
  typeof api.reporting.teamActions.getActionsPerCloserPerDay
>;
export type TeamOutcomeMix = TeamOutcomeMixMetrics;
