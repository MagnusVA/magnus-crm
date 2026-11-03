"use client";

import { useState } from "react";
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

// A DM closer's working week: hours per weekday. Booked Calls divides their
// booked calls by these hours ("booked per hour").

export const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export type WeekHours = Record<Weekday, number>;

const SHORT: Record<Weekday, string> = {
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
  return Object.fromEntries(WEEKDAYS.map((day) => [day, formatHours(week[day])])) as Record<Weekday, string>;
}

export function weekTotal(week: WeekHours) {
  return WEEKDAYS.reduce((sum, day) => sum + week[day], 0);
}

export function formatHours(hours: number) {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1).replace(/\.0$/, "");
}

/** "Mon–Fri · 8 h", "Mon, Wed · 4 h" or "40 h across 6 days". */
export function describeWeek(week: WeekHours) {
  const days = WEEKDAYS.filter((day) => week[day] > 0);
  if (days.length === 0) return "No schedule";
  const same = days.every((day) => week[day] === week[days[0]]);
  if (!same) return `${formatHours(weekTotal(week))} h across ${days.length} days`;
  const indexes = days.map((day) => WEEKDAYS.indexOf(day));
  const consecutive = indexes.every((value, index) => index === 0 || value === indexes[index - 1] + 1);
  const span =
    days.length === 1
      ? SHORT[days[0]]
      : consecutive
        ? `${SHORT[days[0]]}–${SHORT[days[days.length - 1]]}`
        : days.map((day) => SHORT[day]).join(", ");
  return `${span} · ${formatHours(week[days[0]])} h`;
}

/** Seven small cells, one per weekday, with the day's hours or a dash. */
export function WeekStrip({ week, className }: { week: WeekHours; className?: string }) {
  return (
    <span className={cn("inline-flex gap-[3px]", className)} aria-label={describeWeek(week)} role="img">
      {WEEKDAYS.map((day) => (
        <span
          key={day}
          className={cn(
            "flex h-[30px] w-[30px] flex-col items-center justify-center rounded-[4px] border text-center",
            week[day] > 0 ? "border-foreground/15 bg-card" : "border-dashed border-border bg-transparent text-muted-foreground/70",
          )}
        >
          <span className="font-condensed text-[9.5px] leading-none font-semibold tracking-[0.08em] uppercase">
            {SHORT[day].slice(0, 2)}
          </span>
          <span className="mt-[2px] font-condensed text-[12.5px] leading-none font-semibold tabular-nums">
            {week[day] > 0 ? formatHours(week[day]) : "–"}
          </span>
        </span>
      ))}
    </span>
  );
}

/**
 * The editor's Schedule block: the week at a glance, its total and weekly
 * cost, and "Set schedule", which opens the week in place. `open` lives in
 * the URL (`&schedule=1`) so a link can land on it.
 */
export function ScheduleBlock({
  dmCloserId,
  firstName,
  week,
  open,
  onOpenChange,
}: {
  dmCloserId: Id<"dmClosers">;
  firstName: string;
  week: WeekHours;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const total = weekTotal(week);
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5">
        <div className="flex min-w-0 flex-col gap-1">
          <span className={LABEL}>
            <HelpTip
              tip={
                <>
                  The hours {firstName} works each day. Booked Calls divides {firstName}’s booked calls by them
                  (booked per hour). They don’t change which links {firstName} gets.
                </>
              }
            >
              Schedule
            </HelpTip>
          </span>
          <span className="text-[13px] text-muted-foreground">
            <b className="font-semibold text-foreground">{total > 0 ? `${formatHours(total)} h a week` : "No schedule"}</b>
            {total > 0 ? ` · ${describeWeek(week)}` : " · booked per hour stays blank on Booked Calls"}
          </span>
        </div>
        <WeekStrip week={week} className="ml-auto" />
        {!open ? (
          <Button variant="outline" size="sm" onClick={() => onOpenChange(true)}>
            <CalendarClockIcon aria-hidden="true" />
            {total > 0 ? "Edit schedule" : "Set schedule"}
          </Button>
        ) : null}
      </div>
      {open ? (
        <WeekEditor
          dmCloserId={dmCloserId}
          firstName={firstName}
          saved={week}
          onDone={() => onOpenChange(false)}
        />
      ) : null}
    </div>
  );
}

function WeekEditor({
  dmCloserId,
  firstName,
  saved,
  onDone,
}: {
  dmCloserId: Id<"dmClosers">;
  firstName: string;
  saved: WeekHours;
  onDone: () => void;
}) {
  const setSchedule = useMutation(api.workSchedules.setDmCloserWeeklySchedule);
  const [draft, setDraft] = useState(() => toDraft(saved));
  const [saving, setSaving] = useState(false);

  const parsed = fill((day) => {
    const value = Number(String(draft[day]).trim() || "0");
    return Number.isFinite(value) ? value : Number.NaN;
  });
  const invalid = WEEKDAYS.filter((day) => !(parsed[day] >= 0 && parsed[day] <= 24));
  const total = invalid.length ? null : weekTotal(parsed);
  const changed = WEEKDAYS.some((day) => parsed[day] !== saved[day]);

  function setDay(day: Weekday, value: string) {
    setDraft((current) => ({ ...current, [day]: value }));
  }

  async function save() {
    if (invalid.length || !changed) return;
    setSaving(true);
    const previous = saved;
    try {
      await setSchedule({ dmCloserId, scheduledHours: parsed });
      posthog.capture("booking_dm_closer_schedule_set", { weeklyHours: weekTotal(parsed) });
      onDone();
      toast.success(`${firstName}’s schedule: ${describeWeek(parsed)}`, {
        action: {
          label: "Undo",
          onClick: () => {
            setSchedule({ dmCloserId, scheduledHours: previous }).catch((error: unknown) => {
              reportClientError(error, { flow: "booking_dm_closer_schedule_undo" });
              toast.error(getErrorMessage(error, "Couldn’t undo the schedule."));
            });
          },
        },
      });
    } catch (error) {
      reportClientError(error, { flow: "booking_dm_closer_schedule_set" });
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
            onClick={() => setDraft(toDraft(preset.week(invalid.length ? saved : parsed)))}
          >
            {preset.label}
          </Button>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1.5">
        {WEEKDAYS.map((day) => {
          const on = Number(draft[day]) > 0;
          const bad = invalid.includes(day);
          return (
            <label key={day} className="flex min-w-0 flex-col items-center gap-1">
              <button
                type="button"
                aria-pressed={on}
                onClick={() => setDay(day, on ? "0" : String(saved[day] > 0 ? saved[day] : 8))}
                className={cn(
                  "h-6 w-full rounded-[5px] border font-condensed text-[11px] font-semibold tracking-[0.1em] uppercase outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  on ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground hover:bg-muted",
                )}
                title={on ? `${SHORT[day]} is a working day. Click to make it a day off.` : `Make ${SHORT[day]} a working day`}
              >
                {SHORT[day]}
              </button>
              <input
                aria-label={`${SHORT[day]} hours`}
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
            </label>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-[13px] text-muted-foreground">
          {invalid.length ? (
            <span className="text-danger-ink">Hours go from 0 to 24 a day.</span>
          ) : (
            <>
              <b className="font-semibold text-foreground">{formatHours(total ?? 0)} h a week</b>
            </>
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
    </form>
  );
}
