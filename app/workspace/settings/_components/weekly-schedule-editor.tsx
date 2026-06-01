"use client";

import { SaveIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

const weekdays = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

export type Weekday = (typeof weekdays)[number];
export type ScheduleDraft = Record<Weekday, string>;

const weekdayLabels: Record<Weekday, string> = {
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
  sunday: "Sunday",
};

export function WeeklyScheduleEditor(props: {
  value: ScheduleDraft;
  onChange: (next: ScheduleDraft) => void;
  onSave: () => void;
  isSaving: boolean;
}) {
  return (
    <FieldGroup>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {weekdays.map((weekday) => (
          <Field key={weekday}>
            <FieldLabel htmlFor={`schedule-${weekday}`}>
              {weekdayLabels[weekday]}
            </FieldLabel>
            <Input
              id={`schedule-${weekday}`}
              inputMode="decimal"
              min={0}
              max={24}
              step={0.25}
              type="number"
              value={props.value[weekday]}
              onChange={(event) =>
                props.onChange({
                  ...props.value,
                  [weekday]: event.target.value,
                })
              }
            />
          </Field>
        ))}
      </div>
      <Button type="button" onClick={props.onSave} disabled={props.isSaving}>
        {props.isSaving ? (
          <Spinner data-icon="inline-start" />
        ) : (
          <SaveIcon data-icon="inline-start" />
        )}
        Save schedule
      </Button>
    </FieldGroup>
  );
}
