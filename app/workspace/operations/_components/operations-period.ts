export type OperationsPeriod = "all" | "today" | "this_week" | "this_month";

export const OPERATIONS_PERIODS: Array<{
  label: string;
  value: OperationsPeriod;
}> = [
  { label: "All time", value: "all" },
  { label: "Today", value: "today" },
  { label: "This week", value: "this_week" },
  { label: "This month", value: "this_month" },
];

function startOfLocalDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function getOperationsPeriodRange(period: OperationsPeriod) {
  const now = new Date();

  if (period === "today") {
    const start = startOfLocalDay(now);
    const end = new Date(start);
    end.setDate(start.getDate() + 1);
    return { after: start.getTime(), before: end.getTime() };
  }

  if (period === "this_week") {
    const start = startOfLocalDay(now);
    const day = start.getDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    start.setDate(start.getDate() + mondayOffset);
    const end = new Date(start);
    end.setDate(start.getDate() + 7);
    return { after: start.getTime(), before: end.getTime() };
  }

  if (period === "this_month") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return { after: start.getTime(), before: end.getTime() };
  }

  return {};
}
