import type { PipelineNow } from "@/convex/reports/pipeline";
import { DEAL_POSITION_LABELS } from "@/convex/opportunities/stages";
import type { ReportDocument } from "@/lib/operations-reports/document";
import { REPORT_TERMS } from "@/lib/reporting/definitions";
import { definitionsTable } from "@/lib/reporting/export";

// The Pipeline page's shaping (docs/reviews/reports-overhaul.html §12): open
// deals and what they owe right now, with no range.

const wholeNumber = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

export function formatCount(value: number) {
  return wholeNumber.format(value);
}

/** "9.2 days", "1 day", or a dash with nothing to measure. */
export function formatDays(value: number | null | undefined, decimals: 0 | 1 = 0) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const shown = decimals === 0 ? Math.floor(value) : Math.round(value * 10) / 10;
  return `${(decimals === 0 ? wholeNumber : oneDecimal).format(shown)} day${shown === 1 ? "" : "s"}`;
}

export function stageLabel(stage: PipelineNow["stages"][number]["stage"]) {
  return DEAL_POSITION_LABELS[stage];
}

export function openDealCount(data: Pick<PipelineNow, "stages">) {
  return data.stages.reduce((sum, stage) => sum + stage.count, 0);
}

/** The two biggest stages, "92 at Qualified · 119 at Follow-up", in stage order. */
export function stagesProof(data: Pick<PipelineNow, "stages">) {
  const top = [...data.stages]
    .filter((stage) => stage.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 2);
  if (top.length === 0) return "No open deals right now";
  return data.stages
    .filter((stage) => top.includes(stage))
    .map((stage) => `${formatCount(stage.count)} at ${stageLabel(stage.stage)}`)
    .join(" · ");
}

/**
 * Calls owed a result as a band figure. A null total means the count couldn't
 * be read exactly: it reads a dash, never zero, and the proof says why.
 */
export function owedFigure(owed: { total: number | null; partial: boolean }) {
  if (owed.total === null) {
    return { figure: "—", proof: "Couldn't count them all; the oldest are listed below" };
  }
  if (owed.partial) return { figure: formatCount(owed.total), proof: "at least this many calls owe a result" };
  return { figure: formatCount(owed.total), proof: owed.total === 0 ? "every past call has a result" : "calls that owe a result" };
}

/** A count that may be a lower bound, as a figure. */
export function countFigure(value: { count: number; partial: boolean }) {
  return value.partial ? `${formatCount(value.count)}+` : formatCount(value.count);
}

/** What a deal does next: its next call or task, or nothing. */
export function nextStepWords(nextStep: PipelineNow["aging"]["deals"][number]["nextStep"], formatDate: (at: number) => string) {
  if (!nextStep) return null;
  const noun = nextStep.kind === "call" ? "Call" : "Task";
  return nextStep.at === null ? noun : `${noun} ${formatDate(nextStep.at)}`;
}

function dateWords(at: number) {
  return new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** The page as a document: the band's figures, then each card's rows. */
export function buildPipelineDocument(data: PipelineNow, input: { generatedAt: number; dayLine: string }): ReportDocument {
  const owed = owedFigure(data.owed);
  return {
    title: "Pipeline",
    period: `Right now · as of ${new Date(input.generatedAt).toLocaleString("en-US")}`,
    generatedAt: input.generatedAt,
    boundary: input.dayLine,
    filters: "Open deals and what they owe, not a range",
    summary: [
      { label: "Open deals", value: formatCount(openDealCount(data)) },
      { label: REPORT_TERMS.notRecorded.label, value: data.owed.partial && data.owed.total !== null ? `${owed.figure} or more` : owed.figure },
      { label: "No next step", value: countFigure(data.noNextStep) },
      { label: "Overdue tasks", value: countFigure(data.overdueTasks) },
      { label: "Booking reviews", value: countFigure(data.bookingReviews) },
    ],
    tables: [
      {
        title: "Stages",
        columns: [
          { key: "stage", label: "Stage" },
          { key: "deals", label: "Deals", format: "number" },
          { key: "median", label: "Median deal age (days)", format: "decimal" },
          { key: "oldest", label: "Oldest, days", format: "decimal" },
          { key: "partial", label: "Partial" },
        ],
        rows: data.stages.map((stage) => ({
          stage: stageLabel(stage.stage),
          deals: stage.count,
          median: stage.medianAgeDays,
          oldest: stage.oldestAgeDays,
          partial: stage.partial ? "Yes" : "No",
        })),
      },
      {
        title: "Aging",
        columns: [
          { key: "person", label: "Person" },
          { key: "stage", label: "Stage" },
          { key: "age", label: "Deal age (days)", format: "decimal" },
          { key: "closer", label: "Closer" },
          { key: "nextStep", label: "Next step" },
          { key: "dealId", label: "Deal ID" },
        ],
        rows: data.aging.deals.map((deal) => ({
          person: deal.leadName,
          stage: stageLabel(deal.stage),
          age: deal.ageDays,
          closer: deal.closerName,
          nextStep: nextStepWords(deal.nextStep, dateWords) ?? "None",
          dealId: deal.opportunityId,
        })),
      },
      {
        title: "Calls owed a result",
        columns: [
          { key: "person", label: "Person" },
          { key: "closer", label: "Closer" },
          { key: "scheduledAt", label: "Call time", format: "timestamp" },
          { key: "age", label: "Days since", format: "decimal" },
          { key: "meetingId", label: "Call ID" },
          { key: "dealId", label: "Deal ID" },
        ],
        rows: data.owed.calls.map((call) => ({
          person: call.leadName,
          closer: call.closerName,
          scheduledAt: call.scheduledAt,
          age: call.ageDays,
          meetingId: call.meetingId,
          dealId: call.opportunityId,
        })),
      },
      definitionsTable(["notRecorded", "callsDue"]),
    ],
  };
}
