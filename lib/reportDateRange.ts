import { format } from "date-fns";
import { addBusinessDays } from "./businessDay";

/** Controls use an exclusive midnight, while initial ranges may use endOfMonth. */
export function reportDisplayEndDate(endDate: number): Date {
  const end = new Date(endDate);
  if (end.getHours() === 0 && end.getMinutes() === 0 && end.getSeconds() === 0 && end.getMilliseconds() === 0) {
    end.setDate(end.getDate() - 1);
  }
  return end;
}

/** Preserve the browser calendar labels when querying tenant business-day buckets. */
export function reportRangeDayKeys(range: { startDate: number; endDate: number }) {
  return {
    startDayKey: format(range.startDate, "yyyy-MM-dd"),
    endDayKeyExclusive: addBusinessDays(format(reportDisplayEndDate(range.endDate), "yyyy-MM-dd"), 1),
  };
}
