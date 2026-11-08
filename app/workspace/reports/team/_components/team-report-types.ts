import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";

export type TeamPerformanceMetrics = FunctionReturnType<
  typeof api.reporting.teamPerformance.getTeamPerformanceMetrics
>;
export type TeamOperationsDimensions = FunctionReturnType<
  typeof api.reporting.teamPerformance.getTeamOperationsDimensions
>;
export type TeamOutcomeMix = FunctionReturnType<
  typeof api.reporting.teamOutcomes.getTeamOutcomeMix
>;
export type ActionsPerCloserMetrics = FunctionReturnType<
  typeof api.reporting.teamActions.getActionsPerCloserPerDay
>;

export type OutcomeKey = keyof TeamOutcomeMix["displayOutcome"];
export type CallMetrics = TeamPerformanceMetrics["closers"][number]["newCalls"];
export type CloserData = TeamPerformanceMetrics["closers"][number];
export type TeamTotals = TeamPerformanceMetrics["teamTotals"];
export type DerivedOutcomes = TeamOutcomeMix["derived"];
