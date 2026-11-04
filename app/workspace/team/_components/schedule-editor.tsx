"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import posthog from "posthog-js";
import { CalendarClockIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/errors";
import { reportClientError } from "@/lib/observability/report-client-error";
import { cn } from "@/lib/utils";
import { HelpTip, LABEL } from "./team-ui";

// One working week per role record: a lead gen worker's, a Slack qualifier's
// or a DM closer's. The reports divide that role's results by these hours.
// A save applies from the tenant's business date today on; earlier days keep
// the hours they had (convex/lib/workSchedule.ts, "Dated schedules").

export const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export type WeekHours = Record<Weekday, number>;

/** Whose week it is. Each kind saves through its own mutation. */
export type ScheduleOwner =
  | { kind: "lead_gen"; workerId: Id<"leadGenWorkers"> }
  | { kind: "slack"; slackUserId: string }
  | { kind: "dm_closer"; dmCloserId: Id<"dmClosers"> };

export type ScheduleRole = ScheduleOwner["kind"];

export const SHORT_DAY: Record<Weekday, string> = {
  monday: "Mon",
  tuesday: "Tue",
  wednesday: "Wed",
  thursday: "Thu",
  friday: "Fri",
  saturday: "Sat",
  sunday: "Sun",
};

export const EMPTY_WEEK: WeekHours = {
  monday: 0,
  tuesday: 0,
  wednesday: 0,
  thursday: 0,
  friday: 0,
  saturday: 0,
  sunday: 0,
};

/** What each role's hours are for, in the label's hover help and the empty line. */
const ROLE_COPY: Record<ScheduleRole, { tip: (first: string) => ReactNode; empty: (first: string) => string }> = {
  lead_gen: {
    tip: (first) => (
      <>
        The hours {first} works each day as a lead generator. Lead Gen divides {first}’s captures by them (captures
        per hour).
      </>
    ),
    empty: (first) => `captures per hour leaves ${first} out on Lead Gen`,
  },
  slack: {
    tip: (first) => (
      <>
        The hours {first} qualifies leads each day. Qualifications divides {first}’s qualified leads by them
        (qualified per hour).
      </>
    ),
    empty: () => "qualified per hour stays blank on Qualifications",
  },
  dm_closer: {
    tip: (first) => (
      <>
        The hours {first} works each day as a DM closer. Booked Calls divides {first}’s booked calls by them (booked
        per hour). They don’t change which links {first} gets.
      </>
    ),
    empty: () => "booked per hour stays blank on Booked Calls",
  },
};

const ROLE_EVENT: Record<ScheduleRole, string> = {
  lead_gen: "lead_gen_schedule_set",
  slack: "slack_qualifier_schedule_set",
  dm_closer: "booking_dm_closer_schedule_set",
};

const WEEKEND = new Set<Weekday>(["saturday", "sunday"]);

const PRESETS: Array<{ label: string; week: (current: WeekHours) => WeekHours }> = [
  { label: "Weekdays · 8 h", week: () => fill((day) => (WEEKEND.has(day) ? 0 : 8)) },
  { label: "Weekdays · 4 h", week: () => fill((day) => (WEEKEND.has(day) ? 0 : 4)) },
  { label: "Mon–Sat · 6 h", week: () => fill((day) => (day === "sunday" ? 0 : 6)) },
  {
    label: "Copy Monday to weekdays",
    week: (current) => fill((day) => (WEEKEND.has(day) ? current[day] : current.monday)),
  },
  { label: "Clear", week: () => EMPTY_WEEK },
];

function fill(hours: (day: Weekday) => number): WeekHours {
  return Object.fromEntries(WEEKDAYS.map((day) => [day, hours(day)])) as WeekHours;
}

function toDraft(week: WeekHours): Record<Weekday, string> {
  // Exact values: rounding here would turn a saved 7.25 into an unsaved edit.
  return Object.fromEntries(WEEKDAYS.map((day) => [day, String(week[day])])) as Record<Weekday, string>;
}

function sameWeek(left: WeekHours | null, right: WeekHours | null) {
  if (left === null || right === null) return left === right;
  return WEEKDAYS.every((day) => left[day] === right[day]);
}

function sameDraft(left: Record<Weekday, string>, right: Record<Weekday, string>) {
  return WEEKDAYS.every((day) => left[day].trim() === right[day].trim());
}

export function weekTotal(week: WeekHours | null) {
  if (!week) return 0;
  return WEEKDAYS.reduce((sum, day) => sum + week[day], 0);
}

export function formatHours(hours: number) {
  // Two decimals: quarter hours (7.25) show as typed.
  return String(Math.round(hours * 100) / 100);
}

/** "Mon–Fri · 8 h", "Mon, Wed · 4 h", "40 h across 6 days" or "No schedule". */
export function describeWeek(week: WeekHours | null) {
  if (!week) return "No schedule";
  const days = WEEKDAYS.filter((day) => week[day] > 0);
  if (days.length === 0) return "No schedule";
  const same = days.every((day) => week[day] === week[days[0]]);
  if (!same) return `${formatHours(weekTotal(week))} h across ${days.length} days`;
  const indexes = days.map((day) => WEEKDAYS.indexOf(day));
  const consecutive = indexes.every((value, index) => index === 0 || value === indexes[index - 1] + 1);
  const span =
    days.length === 1
      ? SHORT_DAY[days[0]]
      : consecutive
        ? `${SHORT_DAY[days[0]]}–${SHORT_DAY[days[days.length - 1]]}`
        : days.map((day) => SHORT_DAY[day]).join(", ");
  return `${span} · ${formatHours(week[days[0]])} h`;
}

/** "2026-11-03" -> "Nov 3" (a business date, read without a time zone). */
export function formatBusinessDate(dayKey: string) {
  const [year, month, day] = dayKey.split("-").map(Number);
  if (!year || !month || !day) return dayKey;
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

type ScheduleRow = { weekday: Weekday; scheduledHours: number; effectiveFrom?: string };

/**
 * The week in force per owner, from schedule rows (one per weekday per owner).
 * If a weekday has more than one row, the latest `effectiveFrom` wins; an
 * owner with no rows has no entry (no schedule).
 */
export function weeksByOwner<Row extends ScheduleRow>(rows: readonly Row[] | undefined, ownerOf: (row: Row) => string) {
  const weeks = new Map<string, WeekHours>();
  const from = new Map<string, string>();
  for (const row of rows ?? []) {
    const owner = ownerOf(row);
    const key = `${owner}:${row.weekday}`;
    const effectiveFrom = row.effectiveFrom ?? "";
    const seen = from.get(key);
    if (seen !== undefined && seen > effectiveFrom) continue;
    from.set(key, effectiveFrom);
    const week = weeks.get(owner) ?? { ...EMPTY_WEEK };
    week[row.weekday] = row.scheduledHours;
    weeks.set(owner, week);
  }
  return weeks;
}

/** Seven small cells, one per weekday, with the day's hours or a dash. */
export function WeekStrip({ week, className }: { week: WeekHours | null; className?: string }) {
  return (
    <span className={cn("inline-flex gap-[3px]", className)} aria-label={describeWeek(week)} role="img">
      {WEEKDAYS.map((day) => {
        const hours = week?.[day] ?? 0;
        return (
          <span
            key={day}
            className={cn(
              "flex h-[30px] w-[30px] flex-col items-center justify-center rounded-[4px] border text-center",
              hours > 0
                ? "border-foreground/15 bg-card"
                : "border-dashed border-border bg-transparent text-muted-foreground/70",
            )}
          >
            <span className="font-condensed text-[9.5px] leading-none font-semibold tracking-[0.08em] uppercase">
              {SHORT_DAY[day].slice(0, 2)}
            </span>
            <span className="mt-[2px] font-condensed text-[12.5px] leading-none font-semibold tabular-nums">
              {hours > 0 ? formatHours(hours) : "–"}
            </span>
          </span>
        );
      })}
    </span>
  );
}

function useSaveWeek(owner: ScheduleOwner) {
  const setLeadGen = useMutation(api.workSchedules.setLeadGenWeeklySchedule);
  const setSlack = useMutation(api.workSchedules.setSlackQualifierWeeklySchedule);
  const setDmCloser = useMutation(api.workSchedules.setDmCloserWeeklySchedule);
  return (scheduledHours: WeekHours | null) => {
    switch (owner.kind) {
      case "lead_gen":
        return setLeadGen({ workerId: owner.workerId, scheduledHours });
      case "slack":
        return setSlack({ slackUserId: owner.slackUserId, scheduledHours });
      case "dm_closer":
        return setDmCloser({ dmCloserId: owner.dmCloserId, scheduledHours });
    }
  };
}

/**
 * A role's Schedule block: the week at a glance, its total, and "Set
 * schedule", which opens the week editor in place. `open` lives in the URL
 * (`&schedule=…`) so a link can land on it. `week` is null when the role has
 * no schedule; `changedOn` (a business date) shows "Since Nov 3" by the total.
 */
export function ScheduleBlock({
  owner,
  firstName,
  week,
  changedOn,
  open,
  onOpenChange,
  title = "Schedule",
}: {
  owner: ScheduleOwner;
  firstName: string;
  week: WeekHours | null;
  changedOn?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The block's label; a member card with several roles names the role. */
  title?: string;
}) {
  const total = weekTotal(week);
  const copy = ROLE_COPY[owner.kind];
  const block = useRef<HTMLDivElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  // Closing the editor (Save, Cancel, Escape) unmounts what had focus; put it
  // back on the button that opened it. A layout effect, so it runs before a
  // dialog's focus trap moves the lost focus to the dialog itself.
  const wasOpen = useRef(open);
  useLayoutEffect(() => {
    if (wasOpen.current && !open) {
      const active = document.activeElement;
      const lost = !active || active === document.body || active.contains(block.current);
      if (lost || block.current?.contains(active)) editButton.current?.focus();
    }
    wasOpen.current = open;
  }, [open]);

  return (
    <div ref={block} className="flex flex-col gap-2 rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5">
        <div className="flex min-w-0 flex-col gap-1">
          <span className={LABEL}>
            <HelpTip tip={copy.tip(firstName)}>{title}</HelpTip>
          </span>
          <span className="text-[13px] text-muted-foreground">
            <b className="font-semibold text-foreground">{total > 0 ? `${formatHours(total)} h a week` : "No schedule"}</b>
            {total > 0 ? ` · ${describeWeek(week)}` : ` · ${copy.empty(firstName)}`}
            {changedOn ? ` · Since ${formatBusinessDate(changedOn)}` : null}
          </span>
        </div>
        <WeekStrip week={week} className="ml-auto" />
        {!open ? (
          <Button ref={editButton} variant="outline" size="sm" onClick={() => onOpenChange(true)}>
            <CalendarClockIcon aria-hidden="true" />
            {total > 0 ? "Edit schedule" : "Set schedule"}
          </Button>
        ) : null}
      </div>
      {open ? (
        <WeekEditor
          owner={owner}
          firstName={firstName}
          saved={week}
          onDone={() => onOpenChange(false)}
        />
      ) : null}
    </div>
  );
}

/** The week's seven inputs, presets and total. Saves with an Undo toast. */
export function WeekEditor({
  owner,
  firstName,
  saved,
  onDone,
}: {
  owner: ScheduleOwner;
  firstName: string;
  saved: WeekHours | null;
  onDone: () => void;
}) {
  const saveWeek = useSaveWeek(owner);
  const base = saved ?? EMPTY_WEEK;
  const [draft, setDraft] = useState(() => toDraft(base));
  // While nothing is edited, follow the saved week (an Undo, another admin).
  const [baseline, setBaseline] = useState(saved);
  if (!sameWeek(baseline, saved)) {
    setBaseline(saved);
    if (sameDraft(draft, toDraft(baseline ?? EMPTY_WEEK))) setDraft(toDraft(base));
  }
  const [saving, setSaving] = useState(false);
  const firstInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    firstInput.current?.focus();
  }, []);

  const parsed = fill((day) => {
    const value = Number(String(draft[day]).trim() || "0");
    return Number.isFinite(value) ? value : Number.NaN;
  });
  const invalid = WEEKDAYS.filter((day) => !(parsed[day] >= 0 && parsed[day] <= 24));
  const total = invalid.length ? null : weekTotal(parsed);
  const changed = WEEKDAYS.some((day) => parsed[day] !== base[day]);

  function setDay(day: Weekday, value: string) {
    setDraft((current) => ({ ...current, [day]: value }));
  }

  async function save() {
    if (invalid.length || !changed) return;
    setSaving(true);
    // Undo puts back the week shown before the save, or no schedule.
    const previous = saved;
    try {
      await saveWeek(parsed);
      posthog.capture(ROLE_EVENT[owner.kind], { weeklyHours: weekTotal(parsed), role: owner.kind });
      onDone();
      toast.success(`${firstName}’s schedule: ${describeWeek(parsed)}`, {
        description: "From today on",
        action: {
          label: "Undo",
          onClick: () => {
            saveWeek(previous).catch((error: unknown) => {
              reportClientError(error, { flow: "team_schedule_undo", role: owner.kind });
              toast.error(getErrorMessage(error, "Couldn’t undo the schedule."));
            });
          },
        },
      });
    } catch (error) {
      reportClientError(error, { flow: "team_schedule_set", role: owner.kind });
      toast.error(getErrorMessage(error, "Couldn’t save the schedule."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-3 border-t border-border px-3 pt-3 pb-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Presets">
        {PRESETS.map((preset) => (
          <Button
            key={preset.label}
            type="button"
            variant="outline"
            size="xs"
            onClick={() => setDraft(toDraft(preset.week(invalid.length ? base : parsed)))}
          >
            {preset.label}
          </Button>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1.5">
        {WEEKDAYS.map((day, index) => {
          const on = Number(draft[day]) > 0;
          const bad = invalid.includes(day);
          return (
            <div key={day} className="flex min-w-0 flex-col items-center gap-1">
              <button
                type="button"
                aria-pressed={on}
                onClick={() => setDay(day, on ? "0" : String(base[day] > 0 ? base[day] : 8))}
                className={cn(
                  "h-6 w-full rounded-[5px] border font-condensed text-[11px] font-semibold tracking-[0.1em] uppercase outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  on ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground hover:bg-muted",
                )}
                title={on ? `${SHORT_DAY[day]} is a working day. Click to make it a day off.` : `Make ${SHORT_DAY[day]} a working day`}
              >
                {SHORT_DAY[day]}
              </button>
              <input
                ref={index === 0 ? firstInput : undefined}
                aria-label={`${SHORT_DAY[day]} hours`}
                inputMode="decimal"
                value={draft[day]}
                onChange={(event) => setDay(day, event.target.value)}
                onFocus={(event) => event.currentTarget.select()}
                className={cn(
                  "h-8 w-full min-w-0 rounded-[7px] border bg-card text-center font-condensed text-[15px] tabular-nums outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
                  bad ? "border-destructive" : "border-input",
                  !on && !bad && "text-muted-foreground",
                )}
              />
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-[13px] text-muted-foreground">
          {invalid.length ? (
            <span className="text-danger-ink">Hours go from 0 to 24 a day.</span>
          ) : (
            <b className="font-semibold text-foreground">{formatHours(total ?? 0)} h a week</b>
          )}
        </span>
        <div className="ml-auto flex gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={saving || !changed || invalid.length > 0}>
            Save schedule
          </Button>
        </div>
      </div>
      <p className="text-[12px] text-muted-foreground">Changes apply from today. Earlier days keep their hours.</p>
    </form>
  );
}
