"use client";

import { useMemo } from "react";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { weeksByOwner, weekTotal, type WeekHours } from "../schedule-editor";

export type TeamDoc = Doc<"attributionTeams">;
export type DmCloser = FunctionReturnType<typeof api.attribution.dmClosers.listDmClosers>[number];
export type LeadGenWorker = FunctionReturnType<typeof api.leadGen.workers.listWorkers>[number];

export type TeamStats = {
  /** Every lead gen worker on the team, active or not. */
  leadGen: LeadGenWorker[];
  /** Every DM closer whose links carry the team's utm_source, active or not. */
  dmClosers: DmCloser[];
  activeLeadGen: number;
  activeDm: number;
  /** Hours a week in force today, summed over active lead gen workers and DM closers. */
  hours: number;
};

const NO_STATS: TeamStats = { leadGen: [], dmClosers: [], activeLeadGen: 0, activeDm: 0, hours: 0 };

/** "Ana Alonzo", or a worker's email when they have no display name. */
export function workerName(worker: LeadGenWorker) {
  return worker.displayName?.trim() || worker.avatar?.name?.trim() || worker.email;
}

/**
 * Teams with who is on them and their weekly hours: the lead gen workers
 * (`leadGenWorkers.teamId`) and DM closers (`dmClosers.teamId`) of each team,
 * and the week in force today for each of them. Undefined while loading.
 */
export function useTeamsDirectory() {
  const teams = useQuery(api.attribution.teams.listTeams, {});
  const closers = useQuery(api.attribution.dmClosers.listDmClosers, {});
  const workers = useQuery(api.leadGen.workers.listWorkers, { includeInactive: true });
  const dmRows = useQuery(api.workSchedules.listDmCloserSchedules, {});
  const leadGenRows = useQuery(api.leadGen.workers.listWorkerSchedules, {});

  return useMemo(() => {
    if (!teams || !closers || !workers || !dmRows || !leadGenRows) return undefined;
    const dmWeeks: ReadonlyMap<string, WeekHours> = weeksByOwner(dmRows.schedules, (row) => row.dmCloserId);
    const leadGenWeeks: ReadonlyMap<string, WeekHours> = weeksByOwner(leadGenRows, (row) => row.workerId);

    const stats = new Map<string, TeamStats>();
    const statsOf = (teamId: string) => {
      let entry = stats.get(teamId);
      if (!entry) {
        entry = { leadGen: [], dmClosers: [], activeLeadGen: 0, activeDm: 0, hours: 0 };
        stats.set(teamId, entry);
      }
      return entry;
    };
    const noTeam: LeadGenWorker[] = [];
    for (const worker of workers) {
      if (!worker.teamId) {
        if (worker.isActive) noTeam.push(worker);
        continue;
      }
      const entry = statsOf(worker.teamId);
      entry.leadGen.push(worker);
      if (worker.isActive) {
        entry.activeLeadGen += 1;
        entry.hours += weekTotal(leadGenWeeks.get(worker._id) ?? null);
      }
    }
    for (const closer of closers) {
      const entry = statsOf(closer.teamId);
      entry.dmClosers.push(closer);
      if (closer.isActive) {
        entry.activeDm += 1;
        entry.hours += weekTotal(dmWeeks.get(closer._id) ?? null);
      }
    }
    noTeam.sort((a, b) => workerName(a).localeCompare(workerName(b)));

    return {
      teams,
      closers,
      workers,
      dmWeeks,
      leadGenWeeks,
      /** Active lead gen workers with no team. */
      noTeam,
      statsFor: (teamId: string): TeamStats => stats.get(teamId) ?? NO_STATS,
    };
  }, [teams, closers, workers, dmRows, leadGenRows]);
}

export type TeamsDirectory = NonNullable<ReturnType<typeof useTeamsDirectory>>;

/** "14 lead gen · 6 DM", or "Nobody". Counts active members. */
export function membersLine(stats: TeamStats) {
  const parts = [
    stats.activeLeadGen ? `${stats.activeLeadGen} lead gen` : null,
    stats.activeDm ? `${stats.activeDm} DM` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Nobody";
}
