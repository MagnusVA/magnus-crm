export type Granularity = "day" | "week" | "month";

export interface Period {
  key: string;
  start: number;
  end: number;
}

const MAX_PERIODS = 90;

export function getPeriodsInRange(
  startDate: number,
  endDate: number,
  granularity: Granularity,
): Period[] {
  if (!Number.isFinite(startDate) || !Number.isFinite(endDate) || endDate <= startDate) {
    return [];
  }

  const periods: Period[] = [];
  let currentPeriodStart = getPeriodStart(startDate, granularity);

  while (currentPeriodStart < endDate && periods.length < MAX_PERIODS) {
    const nextPeriodStart = getNextPeriodStart(currentPeriodStart, granularity);
    const start = Math.max(startDate, currentPeriodStart);
    const end = Math.min(endDate, nextPeriodStart);

    if (start < end) {
      periods.push({
        key: getPeriodKey(currentPeriodStart, granularity),
        start,
        end,
      });
    }

    currentPeriodStart = nextPeriodStart;
  }

  return periods;
}

export function getPeriodKey(
  timestamp: number,
  granularity: Granularity,
): string {
  const periodStart = getPeriodStart(timestamp, granularity);
  const date = new Date(periodStart);

  switch (granularity) {
    case "day":
      return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(
        date.getUTCDate(),
      )}`;
    case "week": {
      const { week, year } = getIsoWeekInfo(periodStart);
      return `${year}-W${pad2(week)}`;
    }
    case "month":
      return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}`;
  }
}

function getPeriodStart(timestamp: number, granularity: Granularity): number {
  switch (granularity) {
    case "day":
      return startOfUtcDay(timestamp);
    case "week":
      return startOfUtcIsoWeek(timestamp);
    case "month":
      return startOfUtcMonth(timestamp);
  }
}

function getNextPeriodStart(timestamp: number, granularity: Granularity): number {
  const periodStart = getPeriodStart(timestamp, granularity);
  const date = new Date(periodStart);

  switch (granularity) {
    case "day":
      return Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate() + 1,
      );
    case "week":
      return Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate() + 7,
      );
    case "month":
      return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  }
}

function startOfUtcDay(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  );
}

function startOfUtcIsoWeek(timestamp: number): number {
  const date = new Date(startOfUtcDay(timestamp));
  const utcDay = date.getUTCDay() || 7;
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() - (utcDay - 1),
  );
}

function startOfUtcMonth(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function getIsoWeekInfo(timestamp: number): { week: number; year: number } {
  const date = new Date(startOfUtcDay(timestamp));
  const utcDay = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - utcDay);

  const year = date.getUTCFullYear();
  const yearStart = Date.UTC(year, 0, 1);
  const week = Math.ceil((date.getTime() - yearStart + 86400000) / 604800000);

  return { week, year };
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
