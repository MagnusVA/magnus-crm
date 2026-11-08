import { countBusinessDays, nextBusinessPeriodDate } from "@/lib/businessDay";

const MAX_PERIODS = 120;

export type SlackQualificationGranularity = "day" | "week" | "month";

export type SlackQualificationFilters = {
  startBusinessDate: string;
  endBusinessDateExclusive: string;
  granularity: SlackQualificationGranularity;
  slackUserId: string | null;
};

/** Why the report can't answer these filters, or null when it can. */
export function getRangeValidationMessage(filters: SlackQualificationFilters): string | null {
  if (filters.endBusinessDateExclusive <= filters.startBusinessDate) {
    return "Choose an end date after the start date.";
  }
  if (countBusinessDays(filters.startBusinessDate, filters.endBusinessDateExclusive) > 730) {
    return "Choose a range of 730 business days or fewer.";
  }
  if (estimatePeriodCount(filters) > MAX_PERIODS) {
    return `This range creates more than ${MAX_PERIODS} ${filters.granularity} buckets. Narrow the range or use a larger granularity.`;
  }
  return null;
}

function estimatePeriodCount(filters: SlackQualificationFilters): number {
  let cursor = filters.startBusinessDate;
  let periods = 0;
  while (cursor < filters.endBusinessDateExclusive && periods <= MAX_PERIODS) {
    const nextBoundary = nextBusinessPeriodDate(cursor, filters.granularity);
    cursor = nextBoundary < filters.endBusinessDateExclusive ? nextBoundary : filters.endBusinessDateExclusive;
    periods += 1;
  }
  return periods;
}
