"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";
import type { ViewMode } from "./calendar-utils";

/**
 * Lazy-load CalendarView — react-day-picker + date-fns locale + view modes (~80KB).
 * Only downloaded when user visits the closer dashboard, not on initial page load.
 *
 * `{ ssr: false }` prevents server-side rendering — the parent page's Suspense
 * boundary already shows a server-rendered skeleton. The dynamic() `loading`
 * skeleton covers the client-side chunk download phase.
 *
 * @see vercel-react-best-practices: bundle-dynamic-imports
 */
const CalendarView = dynamic(
  () => import("./calendar-view").then((m) => ({ default: m.CalendarView })),
  {
    ssr: false,
    loading: () => <Skeleton className="h-[400px] rounded-xl" />,
  },
);

type CalendarSectionProps = {
  viewMode: ViewMode;
  currentDate: Date;
  startDate: number;
  endDate: number;
  rangeLabel: string;
  onViewModeChange: (mode: ViewMode) => void;
  onCurrentDateChange: (date: Date) => void;
};

/**
 * Calendar section — wraps the lazy-loaded calendar view and forwards the
 * shared filter state owned by the dashboard page.
 */
export function CalendarSection(props: CalendarSectionProps) {
  return (
    <div>
      <h2 className="mb-3 text-lg font-semibold tracking-tight text-pretty">
        My Schedule
      </h2>
      <CalendarView {...props} />
    </div>
  );
}
