import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { ScalarRecord } from "@/convex/operations/reports/contracts";
import type { TopOriginOverviewRow } from "@/app/workspace/_components/top-origins-overview-table";
import { dashboardIdentity } from "./dashboard-identity";

type SnapshotRow = { rowKey: string; payload: ScalarRecord };
type WorkerRow = FunctionReturnType<typeof api.leadGen.reporting.listWorkerPerformance>[number];
const number = (fields: ScalarRecord, key: string) => typeof fields[key] === "number" ? fields[key] : 0;
const text = (fields: ScalarRecord, key: string, fallback = "") => typeof fields[key] === "string" ? fields[key] : fallback;
const nullableNumber = (fields: ScalarRecord, key: string) => typeof fields[key] === "number" ? fields[key] : null;

export function leadDashboardOverview(fields: ScalarRecord) {
  return {
    submissions: number(fields, "submissions"),
    uniqueProspects: number(fields, "uniqueProspects"),
    duplicates: number(fields, "duplicates"),
    scheduledHours: number(fields, "scheduledHours"),
    leadsPerHour: nullableNumber(fields, "leadsPerHour"),
    capped: false,
  };
}

export function leadDashboardWorkers(rows: SnapshotRow[]): WorkerRow[] {
  return rows.map(({ rowKey, payload }) => ({
    workerId: text(payload, "workerId", rowKey) as Id<"leadGenWorkers">,
    worker: dashboardIdentity(payload, rowKey, text(payload, "label", "Unknown worker")),
    displayName: text(payload, "label", "Unknown worker"),
    email: typeof payload.email === "string" ? payload.email : null,
    teamId: typeof payload.teamId === "string" ? payload.teamId as Id<"attributionTeams"> : null,
    isActive: payload.isActive === true,
    submissions: number(payload, "submissions"),
    uniqueProspects: number(payload, "uniqueProspects"),
    duplicates: number(payload, "duplicates"),
    scheduledHours: number(payload, "scheduledHours"),
    leadsPerHour: nullableNumber(payload, "leadsPerHour"),
  })).sort((a, b) => b.submissions - a.submissions);
}

export function leadDashboardTeams(rows: SnapshotRow[]) {
  const teams = new Map<string, { _id: Id<"attributionTeams">; name: string }>();
  for (const { payload } of rows) {
    if (typeof payload.teamId !== "string") continue;
    teams.set(payload.teamId, { _id: payload.teamId as Id<"attributionTeams">, name: text(payload, "teamLabel", "Unknown team") });
  }
  return [...teams.values()];
}

export type LeadDashboardOriginTeam = {
  teamId: string | null;
  teamName: string;
  totalSubmissions: number;
  origins: TopOriginOverviewRow[];
};

export function sortLeadDashboardOriginTeams(groups: LeadDashboardOriginTeam[]) {
  return [...groups].sort((a, b) => {
    if (a.teamId === null && b.teamId !== null) return 1;
    if (b.teamId === null && a.teamId !== null) return -1;
    return b.totalSubmissions - a.totalSubmissions || a.teamName.localeCompare(b.teamName);
  });
}

export function leadDashboardOriginsByTeam(rows: SnapshotRow[]): LeadDashboardOriginTeam[] {
  const groups = new Map<string, LeadDashboardOriginTeam>();
  for (const { rowKey, payload } of rows) {
    if (payload.originKind !== "post" && payload.originKind !== "reel") continue;
    const submissions = number(payload, "submissions");
    if (submissions <= 0) continue;
    const teamId = typeof payload.teamId === "string" ? payload.teamId : null;
    const key = teamId ?? "unassigned";
    const group = groups.get(key) ?? {
      teamId,
      teamName: teamId ? text(payload, "teamLabel", "Unknown team") : "Unassigned",
      totalSubmissions: 0,
      origins: [],
    };
    group.totalSubmissions += submissions;
    group.origins.push({
      originKey: text(payload, "originKey", rowKey),
      source: text(payload, "source"),
      originKind: payload.originKind,
      originValue: text(payload, "originValue"),
      submissions,
      uniqueProspects: number(payload, "uniqueProspects"),
    });
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    // Snapshot pages arrive in export order. Rank only after all pages arrive.
    group.origins.sort((a, b) => b.submissions - a.submissions
      || b.uniqueProspects - a.uniqueProspects
      || a.originValue.localeCompare(b.originValue));
    group.origins = group.origins.slice(0, 10);
  }
  return sortLeadDashboardOriginTeams([...groups.values()]);
}
