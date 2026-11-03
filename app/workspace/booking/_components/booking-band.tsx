"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { PageBand } from "@/app/workspace/_components/page-band";
import { toast } from "sonner";
import { getErrorMessage } from "@/lib/errors";
import { reportClientError } from "@/lib/observability/report-client-error";
import { cn } from "@/lib/utils";
import { eventTypeStatus } from "./booking-model";

export { BOOKING_ROOT_CLASS as BOOKING_ROOT } from "./booking-layout";

const SECTIONS = [
  { href: "/workspace/booking", label: "Coverage", exact: true },
  { href: "/workspace/booking/inbox", label: "Inbox" },
  { href: "/workspace/booking/event-types", label: "Event types" },
  { href: "/workspace/booking/teams", label: "DM teams" },
  { href: "/workspace/booking/portal", label: "Link portal" },
] as const;

/** In-band tabs: the directory band's style (DESIGN.md, The directory band). */
const TAB =
  "inline-flex h-10 shrink-0 items-center gap-1.5 border-b-2 border-transparent font-condensed text-[13px] font-semibold tracking-[0.12em] whitespace-nowrap text-board-muted uppercase outline-none hover:text-board-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-[current=page]:border-primary aria-[current=page]:text-board-foreground";

/**
 * The booking setup band: one title for the five sections and the tabs
 * between them. The Inbox tab counts event types waiting to be sorted.
 * It also moves a tenant onto booking coverage the first time an admin
 * opens any section (`ensureCoverage` does nothing after that).
 */
export function BookingBand({
  description,
  actions,
  children,
}: {
  description: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const pathname = usePathname();
  const coverage = useQuery(api.bookingSetup.queries.getCoverage, {});
  const unsorted = coverage?.eventTypes.filter((eventType) => eventTypeStatus(eventType) === "unsorted").length;
  useEnsureCoverage(coverage?.migrated);

  return (
    <PageBand title="Booking setup" description={description} actions={actions}>
      <div className="-mx-4 border-t border-board-line px-4 @lg:-mx-[18px] @lg:px-[18px]">
        <nav aria-label="Booking setup sections" className="flex min-w-0 gap-4 overflow-x-auto [scrollbar-width:none] @xl:gap-[22px]">
          {SECTIONS.map((section) => {
            const active = "exact" in section ? pathname === section.href : pathname.startsWith(section.href);
            return (
              <Link key={section.href} href={section.href} aria-current={active ? "page" : undefined} className={TAB}>
                {section.label}
                {section.href === "/workspace/booking/inbox" && unsorted ? (
                  <span className="rounded-full bg-warning px-1.5 font-condensed text-[11px] leading-[18px] tracking-normal text-board tabular-nums">
                    {unsorted}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </nav>
      </div>
      {children}
    </PageBand>
  );
}

function useEnsureCoverage(migrated: boolean | undefined) {
  const ensureCoverage = useMutation(api.bookingSetup.mutations.ensureCoverage);
  const started = useRef(false);
  useEffect(() => {
    if (migrated !== false || started.current) return;
    started.current = true;
    const run = () => {
      ensureCoverage({}).catch((error: unknown) => {
        reportClientError(error, { flow: "booking_setup_ensure_coverage" });
        toast.error(getErrorMessage(error, "Couldn't move this workspace to the new booking layout."), {
          duration: Infinity,
          action: { label: "Try again", onClick: run },
        });
      });
    };
    run();
  }, [ensureCoverage, migrated]);
}

/** A 13px condensed figure pair for the band ("48 / 60 covered"). */
export function BandFigure({
  value,
  label,
  tone = "default",
}: {
  value: React.ReactNode;
  label: string;
  tone?: "default" | "warning" | "danger";
}) {
  return (
    <div className="flex min-w-0 flex-col">
      <span
        className={cn(
          "font-condensed text-[26px] leading-none font-semibold tabular-nums",
          tone === "warning" && "text-warning",
          tone === "danger" && "text-board-danger",
        )}
      >
        {value}
      </span>
      <span className="mt-1 font-condensed text-[11px] font-semibold tracking-[0.14em] text-board-muted uppercase">
        {label}
      </span>
    </div>
  );
}
