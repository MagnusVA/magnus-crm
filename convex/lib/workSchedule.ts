import { v } from "convex/values";
import { businessDateToUtcStart } from "../reporting/lib/hondurasBusinessTime";

export const weekdayValidator = v.union(
  v.literal("monday"),
  v.literal("tuesday"),
  v.literal("wednesday"),
  v.literal("thursday"),
  v.literal("friday"),
  v.literal("saturday"),
  v.literal("sunday"),
);

export const weekdays = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

export type Weekday = (typeof weekdays)[number];

const weekdaysByUtcDay: readonly Weekday[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

export function weekdayForBusinessDate(dayKey: string): Weekday {
  businessDateToUtcStart(dayKey);
  const date = new Date(`${dayKey}T12:00:00.000Z`);
  const weekday = weekdaysByUtcDay[date.getUTCDay()];
  if (!weekday) {
    throw new Error("Invalid business date weekday");
  }
  return weekday;
}
