import type { DealPosition, SystemLossReason } from "@/convex/opportunities/stages";
import { dealPositionLabel } from "@/convex/opportunities/stageLabels";
import { addBusinessDays, businessDateForInstant, type BusinessDaySetting } from "@/lib/businessDay";
import { resolveNextStep, type DeskNextStep, type ShownStep } from "@/lib/closer-pipeline";
import { cn } from "@/lib/utils";
import { formatBusinessDate, formatClock } from "@/app/workspace/closer/_components/today-time";

// The cells My Pipeline's rows share: the stage word, the next step and the
// row link to the deal on the person's page.

/** Where a deal row goes: the deal on the person's page, as the Tasks card links it. */
export function dealHref(leadId: string, opportunityId: string) {
  return `/workspace/leads-customers/${leadId}?opportunityId=${opportunityId}`;
}

/** A link that covers its whole row, with an inset focus ring. */
export const ROW_LINK =
  "outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring";

const STAGE_INK: Record<DealPosition, string> = {
  qualified: "text-stage-held-ink",
  booked: "text-stage-booked-ink",
  call_held: "text-stage-held-ink",
  follow_up: "text-stage-follow-up-ink",
  won: "text-stage-won-ink",
  lost: "text-stage-lost-ink",
};

/** The deal's stage as one condensed word in its stage ink: BOOKED, CALL HELD, LOST: NO-SHOW. */
export function StageWord({
  position,
  systemLoss,
  className,
}: {
  position: DealPosition;
  systemLoss?: SystemLossReason | null;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "font-condensed text-[13px] leading-none font-bold tracking-[0.08em] whitespace-nowrap uppercase",
        STAGE_INK[position],
        className,
      )}
    >
      {dealPositionLabel(position, systemLoss)}
    </span>
  );
}

/** "today 3:00 PM", "tomorrow 11:00 AM", "Thu 4:30 PM", "Nov 12, 4:30 PM". */
function whenLabel(at: number, now: number, setting: BusinessDaySetting) {
  const today = businessDateForInstant(now, setting);
  const day = businessDateForInstant(at, setting);
  const clock = formatClock(at, setting.timeZone);
  if (day === today) return `today ${clock}`;
  if (day === addBusinessDays(today, 1)) return `tomorrow ${clock}`;
  if (day === addBusinessDays(today, -1)) return `yesterday ${clock}`;
  if (day > today && day <= addBusinessDays(today, 6)) {
    return `${formatBusinessDate(day, { weekday: "short" })} ${clock}`;
  }
  return formatBusinessDate(day, { month: "short", day: "numeric" });
}

/**
 * The deal's next step in words, as of `now` (`resolveNextStep`): "Call Thu
 * 4:30 PM" while the call is ahead, else its task, "Call back today 3:00 PM"
 * (red once it is past) or "Reschedule link sent", else the amber "No next
 * step", the one thing this page flags. A call that passed with no result is
 * never the step; it is noted on its own line under it.
 */
export function NextStep({
  next,
  now,
  setting,
}: {
  next: DeskNextStep;
  now: number;
  setting: BusinessDaySetting;
}) {
  const { step, missedCallAt } = resolveNextStep(next, now);
  // A call that passed with no result goes on its own line under the step,
  // so it never truncates the step or the amber flag.
  const missed =
    missedCallAt === null ? null : (
      <span className="block truncate text-xs text-muted-foreground">
        {formatBusinessDate(businessDateForInstant(missedCallAt, setting), { month: "short", day: "numeric" })} call, no result
      </span>
    );
  if (step === null) {
    return (
      <span className="flex min-w-0 flex-col items-start gap-0.5">
        <span className="inline-flex h-5 shrink-0 items-center rounded-[4px] bg-warning-surface px-1.5 text-xs font-semibold whitespace-nowrap text-warning-ink">
          No next step
        </span>
        {missed}
      </span>
    );
  }
  return (
    <span className="flex min-w-0 flex-col">
      <span className="truncate">
        <StepWords step={step} now={now} setting={setting} />
      </span>
      {missed}
    </span>
  );
}

function StepWords({
  step,
  now,
  setting,
}: {
  step: Exclude<ShownStep, null>;
  now: number;
  setting: BusinessDaySetting;
}) {
  if (step.kind === "link") {
    return (
      <>
        {step.reschedule ? "Reschedule link sent" : "Scheduling link sent"}
        <span className="text-muted-foreground">
          {" "}
          · {formatBusinessDate(businessDateForInstant(step.sentAt, setting), { month: "short", day: "numeric" })}
        </span>
      </>
    );
  }
  if (step.kind === "call") {
    return (
      <>
        Call <Time>{whenLabel(step.at, now, setting)}</Time>
      </>
    );
  }
  const verb = step.method === "text" ? "Text back" : "Call back";
  if (step.dueAt === null) return <>{verb}</>;
  const overdue = step.dueAt < now;
  return (
    <>
      {verb}{" "}
      <Time className={overdue ? "text-danger-ink" : undefined}>{whenLabel(step.dueAt, now, setting)}</Time>
    </>
  );
}

function Time({ className, children }: { className?: string; children: React.ReactNode }) {
  return <span className={cn("tabular-nums", className)}>{children}</span>;
}
