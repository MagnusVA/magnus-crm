import type {
  getOverview,
  listWorkerPerformance,
  listTopOriginsByTeam,
} from "../../leadGen/reporting";
import type { listProspectConversions } from "../../leadGen/conversions";
import type { listResparkPerformance } from "../../leadGen/resparkReports";
import type { getMyActivitySummary } from "../../leadGen/activity";
import type { ReaderOutput } from "../definition";
import { addCounts, joinOntoToday, mergeRows, rate } from "./helpers";

type Overview = ReaderOutput<typeof getOverview>;
type Workers = ReaderOutput<typeof listWorkerPerformance>;
type Origins = ReaderOutput<typeof listTopOriginsByTeam>;
type Conversions = ReaderOutput<typeof listProspectConversions>;
type Resparks = ReaderOutput<typeof listResparkPerformance>;
type Activity = ReaderOutput<typeof getMyActivitySummary>;

// Unique prospects in these daily totals count prospect-days, so they add
// exactly across the business-day boundary, as do the scheduled hours.
function mergeDaily<
  Summary extends { submissions: number; scheduledHours: number; leadsPerHour: number | null },
>(past: Summary, current: Summary): Summary {
  const submissions = past.submissions + current.submissions;
  const scheduledHours = past.scheduledHours + current.scheduledHours;
  return {
    ...current,
    submissions,
    scheduledHours,
    leadsPerHour: rate(submissions, scheduledHours),
  };
}

export function mergeLeadGenOverview(history: Overview, today: Overview): Overview {
  return {
    ...mergeDaily(history, today),
    uniqueProspects: history.uniqueProspects + today.uniqueProspects,
    duplicates: history.duplicates + today.duplicates,
    capped: history.capped || today.capped,
  };
}

// The builder sorts only by submissions. Ties retain the available row
// order; the answers do not carry the first daily row that broke that tie.
export function mergeLeadGenWorkers(history: Workers, today: Workers): Workers {
  return mergeRows(
    history,
    today,
    (row) => row.workerId,
    (past, current) => ({
      ...mergeDaily(past, current),
      uniqueProspects: past.uniqueProspects + current.uniqueProspects,
      duplicates: past.duplicates + current.duplicates,
    }),
  ).sort((left, right) => right.submissions - left.submissions);
}

// The page asks for ten origins per team, ranked by submissions. Each input
// is already cut: an origin outside one half's top ten loses that half's
// counts, and an origin outside both is unavailable. Merge the candidates
// we have, then rank and cut again. Team totals still add exactly.
export function mergeLeadGenTopOriginsByTeam(history: Origins, today: Origins): Origins {
  return mergeRows(
    history,
    today,
    (row) => row.teamId ?? "",
    (past, current) => ({
      ...current,
      totalUniqueProspects: past.totalUniqueProspects + current.totalUniqueProspects,
      totalSubmissions: past.totalSubmissions + current.totalSubmissions,
      origins: mergeRows(
        past.origins,
        current.origins,
        (row) => `${row.source}:${row.originKey}`,
        (left, right) => ({
          ...right,
          submissions: left.submissions + right.submissions,
          uniqueProspects: left.uniqueProspects + right.uniqueProspects,
          dayCount: left.dayCount + right.dayCount,
        }),
      ),
    }),
  )
    .map((team) => ({
      ...team,
      origins: [...team.origins]
        .sort(
          (left, right) =>
            right.submissions - left.submissions ||
            right.uniqueProspects - left.uniqueProspects ||
            left.originValue.localeCompare(right.originValue),
        )
        .slice(0, 10),
    }))
    .sort(
      (left, right) =>
        right.totalUniqueProspects - left.totalUniqueProspects ||
        right.totalSubmissions - left.totalSubmissions ||
        left.teamName.localeCompare(right.teamName),
    );
}

// As with workers, the builder leaves equal prospect totals in its input
// order; that registry order is unavailable for rows absent from one half.
export function mergeLeadGenProspectConversions(
  history: Conversions,
  today: Conversions,
): Conversions {
  return {
    rows: mergeRows(
      history.rows,
      today.rows,
      (row) => row.workerId,
      (past, current) => ({
        ...current,
        counts: addCounts(past.counts, current.counts),
        deals: past.deals + current.deals,
      }),
    ).sort((left, right) => right.counts.prospect - left.counts.prospect),
    capped: history.capped || today.capped,
    dealsCapped: history.dealsCapped || today.dealsCapped,
  };
}

export function mergeLeadGenResparkPerformance(history: Resparks, today: Resparks): Resparks {
  const rawLeadsCapped = history.rawLeadsCapped || today.rawLeadsCapped;
  return {
    // Every current worker is listed, including workers with zero activity.
    rows: joinOntoToday(
      history.rows,
      today.rows,
      (row) => row.workerId,
      (past, current) => {
        const rawLeads =
          past.rawLeads === null || current.rawLeads === null
            ? null
            : past.rawLeads + current.rawLeads;
        const resparks = past.resparks + current.resparks;
        const notAFit = past.notAFit + current.notAFit;
        return {
          ...current,
          rawLeads,
          resparks,
          notAFit,
          entries: rawLeads === null ? null : rawLeads + resparks,
          notAFitShare: rate(notAFit, resparks + notAFit),
          resparkedThenBooked: past.resparkedThenBooked + current.resparkedThenBooked,
        };
      },
    ).map((row) => (rawLeadsCapped ? { ...row, rawLeads: null, entries: null } : row)),
    capped: history.capped || today.capped,
    rawLeadsCapped,
    bookedCapped: history.bookedCapped || today.bookedCapped,
  };
}

export function mergeMyActivitySummary(history: Activity, today: Activity): Activity {
  const submissions = history.submissions + today.submissions;
  const resparks = history.resparks + today.resparks;
  const startBusinessDate = history.range.startBusinessDate;
  const endBusinessDateInclusive = today.range.endBusinessDateInclusive;
  return {
    ...mergeDaily(history, today),
    resparks,
    notAFit: history.notAFit + today.notAFit,
    entries: submissions + resparks,
    range: {
      ...today.range,
      startBusinessDate,
      dayCount: history.range.dayCount + today.range.dayCount,
      label:
        startBusinessDate === endBusinessDateInclusive
          ? startBusinessDate
          : `${startBusinessDate} to ${endBusinessDateInclusive}`,
    },
  };
}
