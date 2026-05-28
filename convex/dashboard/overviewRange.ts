import { v } from "convex/values";
import {
  addBusinessDays,
  businessDateToUtcStart,
  countBusinessDays,
  timestampToBusinessDateKey,
} from "../reporting/lib/hondurasBusinessTime";
import type { PublicOverviewRange } from "./overviewTypes";

export const MAX_OVERVIEW_CUSTOM_DAYS = 120;

export const overviewRangeValidator = v.union(
  v.object({
    kind: v.literal("preset"),
    preset: v.union(
      v.literal("today"),
      v.literal("this_week"),
      v.literal("this_month"),
    ),
  }),
  v.object({
    kind: v.literal("custom"),
    startBusinessDate: v.string(),
    endBusinessDateInclusive: v.string(),
  }),
);

export type OverviewRangeInput =
  | { kind: "preset"; preset: "today" | "this_week" | "this_month" }
  | {
      kind: "custom";
      startBusinessDate: string;
      endBusinessDateInclusive: string;
    };

export type DerivedOverviewRange = PublicOverviewRange & {
  input: OverviewRangeInput;
  slackWindowStart: number;
  slackWindowEnd: number;
  operationsStartDate: number;
  operationsEndDate: number;
  operationsStartDayKey: string;
  operationsEndDayKeyExclusive: string;
};

export function deriveOverviewRange(
  input: OverviewRangeInput,
  now: number,
): DerivedOverviewRange {
  const today = timestampToBusinessDateKey(now);
  const tomorrow = addBusinessDays(today, 1);
  const startBusinessDate =
    input.kind === "custom"
      ? input.startBusinessDate
      : input.preset === "this_week"
        ? startOfBusinessIsoWeek(today)
        : input.preset === "this_month"
          ? startOfBusinessMonth(today)
          : today;
  const endBusinessDateInclusive =
    input.kind === "custom" ? input.endBusinessDateInclusive : today;
  const endBusinessDateExclusive =
    input.kind === "custom"
      ? addBusinessDays(endBusinessDateInclusive, 1)
      : tomorrow;

  businessDateToUtcStart(startBusinessDate);
  businessDateToUtcStart(endBusinessDateInclusive);

  if (startBusinessDate > endBusinessDateInclusive) {
    throw new Error("Start date must be on or before end date.");
  }

  const dayCount = countBusinessDays(
    startBusinessDate,
    endBusinessDateExclusive,
  );
  if (dayCount > MAX_OVERVIEW_CUSTOM_DAYS) {
    throw new Error(
      `Dashboard range cannot exceed ${MAX_OVERVIEW_CUSTOM_DAYS} days.`,
    );
  }

  const slackWindowStart = businessDateToUtcStart(startBusinessDate);
  const slackWindowEnd = businessDateToUtcStart(endBusinessDateExclusive);

  return {
    input,
    startBusinessDate,
    endBusinessDateInclusive,
    endBusinessDateExclusive,
    slackWindowStart,
    slackWindowEnd,
    operationsStartDate: Date.parse(`${startBusinessDate}T00:00:00.000Z`),
    operationsEndDate: Date.parse(`${endBusinessDateExclusive}T00:00:00.000Z`),
    operationsStartDayKey: startBusinessDate,
    operationsEndDayKeyExclusive: endBusinessDateExclusive,
    dayCount,
    label:
      startBusinessDate === endBusinessDateInclusive
        ? startBusinessDate
        : `${startBusinessDate} to ${endBusinessDateInclusive}`,
    operationsBoundary: "utc_day_key",
  };
}

export function toPublicOverviewRange(
  range: DerivedOverviewRange,
): PublicOverviewRange {
  return {
    startBusinessDate: range.startBusinessDate,
    endBusinessDateInclusive: range.endBusinessDateInclusive,
    endBusinessDateExclusive: range.endBusinessDateExclusive,
    dayCount: range.dayCount,
    label: range.label,
    operationsBoundary: range.operationsBoundary,
  };
}

function startOfBusinessIsoWeek(dateKey: string) {
  businessDateToUtcStart(dateKey);
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const utcDay = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - (utcDay - 1));
  return date.toISOString().slice(0, 10);
}

function startOfBusinessMonth(dateKey: string) {
  businessDateToUtcStart(dateKey);
  return `${dateKey.slice(0, 7)}-01`;
}
