"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";

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

/**
 * Calendar section — wraps the lazy-loaded calendar view.
 * Suspense boundary in parent page handles streaming.
 */
export function CalendarSection() {
  return (
    <div>
      <h2 className="mb-3 text-lg font-semibold tracking-tight text-pretty">
        My Schedule
      </h2>
      <CalendarView />
    </div>
  );
}
