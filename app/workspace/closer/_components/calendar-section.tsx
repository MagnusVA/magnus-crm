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
    <div className="min-w-0">
      <div className="mb-2">
        <h2 className="text-lg font-semibold text-pretty">My Schedule</h2>
        <p className="text-xs text-muted-foreground">
          Switch between day, week and month. Click any meeting to see its
          details and jump into the call.
        </p>
      </div>
      <CalendarView {...props} />
    </div>
  );
}
