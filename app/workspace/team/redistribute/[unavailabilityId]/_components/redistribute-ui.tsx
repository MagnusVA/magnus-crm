import type { ReactNode } from "react";
import { format } from "date-fns";
import { CheckIcon } from "lucide-react";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import { PageBand } from "@/app/workspace/_components/page-band";
import { CARD } from "@/app/workspace/team/_components/team-ui";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// Pieces shared by the Redistribute wizard and its skeleton. No hooks here,
// so loading.tsx draws the same frame.

export type UnavailabilityData = NonNullable<
  FunctionReturnType<typeof api.unavailability.queries.getUnavailabilityWithMeetings>
>;
export type Unavailability = UnavailabilityData["unavailability"];
export type AffectedCall = UnavailabilityData["affectedMeetings"][number];
export type CandidateCloser = FunctionReturnType<typeof api.unavailability.queries.getAvailableClosersForDate>[number];

/** The page root: the container every card folds by, on an 1100px measure. */
export const REDISTRIBUTE_ROOT =
  "@container mx-auto flex w-full max-w-[1100px] min-w-0 flex-col gap-3.5 pb-6 short:gap-3";

export type WizardStep = "review" | "distribute" | "resolve" | "complete";

const STEPS: Array<{ step: WizardStep; label: string }> = [
  { step: "review", label: "Review" },
  { step: "distribute", label: "Choose closers" },
  { step: "resolve", label: "Resolve" },
  { step: "complete", label: "Done" },
];

/** One step in the band: the Team band's tab grammar, but not a link. */
const STEP_CLASS =
  "flex h-10 shrink-0 items-center gap-[7px] border-b-2 border-transparent font-condensed text-[13px] font-semibold tracking-[0.12em] whitespace-nowrap text-board-muted uppercase aria-[current=step]:border-primary aria-[current=step]:text-board-foreground";

/**
 * The wizard's steps under the band's rule, read-only: the current one over
 * the 2px lime underline, the ones behind it with a check. Resolve gets no
 * check when nothing needed resolving.
 */
export function StepTabs({ step, skipped }: { step: WizardStep; skipped?: WizardStep[] }) {
  const current = STEPS.findIndex((candidate) => candidate.step === step);
  return (
    <ol
      aria-label="Steps"
      className="-mx-4 flex items-center gap-[22px] overflow-x-auto border-t border-board-line px-4 [scrollbar-width:none] @lg:-mx-[18px] @lg:px-[18px]"
    >
      {STEPS.map((candidate, index) => {
        const done = index < current && !skipped?.includes(candidate.step);
        return (
          <li key={candidate.step} aria-current={index === current ? "step" : undefined} className={STEP_CLASS}>
            {done ? <CheckIcon className="size-3.5" aria-hidden="true" /> : null}
            {candidate.label}
            {done ? <span className="sr-only">, done</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

// ─── Words and times ────────────────────────────────────────────────

/** "9:00 AM". */
export function formatTime(timestamp: number) {
  return format(new Date(timestamp), "h:mm a");
}

/** "Thursday, Nov 5". */
export function formatDay(timestamp: number) {
  return format(new Date(timestamp), "EEEE, MMM d");
}

/** "1:00–4:30 PM", or "11:00 AM – 2:00 PM" across noon. */
export function formatHours(start: number, end: number) {
  const startMeridiem = format(new Date(start), "a");
  const endMeridiem = format(new Date(end), "a");
  return startMeridiem === endMeridiem
    ? `${format(new Date(start), "h:mm")}–${formatTime(end)}`
    : `${formatTime(start)} – ${formatTime(end)}`;
}

const REASON_LABEL: Record<string, string> = {
  sick: "Sick",
  emergency: "Emergency",
  personal: "Personal",
};

/** "Sick", "Emergency", "Personal"; "other" has no word. */
export function reasonLabel(reason: string | null | undefined) {
  return reason ? (REASON_LABEL[reason] ?? null) : null;
}

/** "off sick", "off for an emergency", "off for personal reasons", "off". */
export function offPhrase(reason: string) {
  if (reason === "sick") return "off sick";
  if (reason === "emergency") return "off for an emergency";
  if (reason === "personal") return "off for personal reasons";
  return "off";
}

/** The day, and the hours when the record covers part of it. */
export function dayAndHours(unavailability: Unavailability) {
  const day = formatDay(unavailability.date);
  return unavailability.isFullDay || unavailability.startTime === undefined || unavailability.endTime === undefined
    ? `${day} · all day`
    : `${day} · ${formatHours(unavailability.startTime, unavailability.endTime)}`;
}

/** "Marcus Bell’s". */
export function possessive(name: string) {
  return `${name}’s`;
}

// ─── Rows ───────────────────────────────────────────────────────────

/** A condensed status word, coloured by meaning. */
export const STATUS_WORD =
  "font-condensed text-[13px] leading-[1.1] font-bold tracking-[0.08em] whitespace-nowrap uppercase";

/** A time or count in a row: condensed, tabular. */
export const ROW_FIGURE = "font-condensed text-[15px] leading-none font-semibold tabular-nums";

/**
 * A checked box in ink, not lime: lime stays for the page's one next action.
 * The box's own hit area reaches past it; the row it sits in is its label.
 */
export const INK_CHECKBOX =
  "data-checked:border-foreground data-checked:bg-foreground data-checked:text-background dark:data-checked:bg-foreground";

/** A selectable row: the whole 44px line is the checkbox's label. */
export const SELECT_ROW =
  "relative min-h-[52px] cursor-pointer border-b border-border px-4 py-2 last:border-b-0 hover:bg-muted/60 has-[:focus-visible]:bg-muted/60 has-data-checked:bg-muted/40 has-disabled:cursor-default has-disabled:hover:bg-transparent";

/** One dense fact: a 120px slate label column beside the value, about 32px, lined up with the form rows (SettingRow). */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-h-8 grid-cols-[7.5rem_minmax(0,1fr)] items-baseline gap-x-3 px-4 py-1.5 @4xl:gap-x-5">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

/** A card's paper footer: actions on the right, a note or a way back on the left. */
export function CardFooter({ aside, children }: { aside?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2 border-t border-border bg-background px-4 py-3">
      {aside ? <div className="mr-auto min-w-0 text-[13px] text-muted-foreground">{aside}</div> : null}
      <div className="flex flex-wrap items-center justify-end gap-2">{children}</div>
    </div>
  );
}

// ─── Skeleton ───────────────────────────────────────────────────────

/** A bone on the band, as a span: it sits inside the band's h1 and p. */
function BandBone({ className }: { className: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block max-w-full animate-pulse rounded-md bg-board-raised align-middle", className)}
    />
  );
}

/** The band and the Review card at their real heights, rows folding at the same step. */
export function RedistributeSkeleton({ label = "Loading redistribution" }: { label?: string }) {
  return (
    <div className={REDISTRIBUTE_ROOT} role="status" aria-label={label}>
      <PageBand
        back={{ href: "/workspace/team", label: "Team" }}
        title={<BandBone className="h-6 w-80" />}
        description={<BandBone className="h-3.5 w-72" />}
      >
        <StepTabs step="review" />
      </PageBand>
      <div className={cn(CARD, "@container/calls")}>
        <div className="flex min-h-11 items-center gap-2.5 border-b border-border px-4 py-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="ml-auto h-4 w-20" />
        </div>
        <div className="hidden min-h-7 items-end gap-4 border-b border-border px-4 pb-1.5 @3xl/calls:flex">
          <Skeleton className="ml-9 h-2.5 w-10" />
          <Skeleton className="ml-12 h-2.5 w-12" />
        </div>
        {Array.from({ length: 8 }, (_, index) => (
          <div
            key={index}
            className="flex min-h-[52px] items-center gap-4 border-b border-border px-4 py-2 last:border-b-0 @3xl/calls:min-h-11 @3xl/calls:py-1.5"
          >
            <Skeleton className="size-4 rounded-[4px]" />
            <Skeleton className="hidden h-4 w-16 @3xl/calls:block" />
            <Skeleton className="hidden h-3.5 w-12 @3xl/calls:block" />
            <Skeleton className="h-4 w-40" />
            <Skeleton className="ml-auto h-3.5 w-16" />
          </div>
        ))}
        <div className="flex justify-end border-t border-border bg-background px-4 py-3">
          <Skeleton className="h-8 w-40" />
        </div>
      </div>
    </div>
  );
}
