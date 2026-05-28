import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";

export type OverviewDashboard = FunctionReturnType<
	typeof api.dashboard.overview.getOverviewDashboard
>;

export type OverviewSection<T extends keyof OverviewDashboard> =
	OverviewDashboard[T];

export type LeadGenOverviewSection = OverviewSection<"leadGen">;
export type TopQualifiersSection = OverviewSection<"topQualifiers">;
export type TopDmClosersSection = OverviewSection<"topDmClosers">;
export type PhoneCloserOperationsSectionData =
	OverviewSection<"phoneCloserOperations">;
export type TopOriginsSection = OverviewSection<"topOrigins">;
