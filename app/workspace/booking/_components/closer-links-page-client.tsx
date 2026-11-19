"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePageTitle } from "@/hooks/use-page-title";
import { BookingPageSkeleton } from "./booking-page-skeleton";
import { CloserLinksCard } from "./closer-links/closer-links-card";
import { ProgramLinkCodesCard } from "./closer-links/program-link-codes-card";

/**
 * Closer links: each active phone closer's own Calendly link (picked from
 * their one-on-one event types or pasted), whether DM closers see it in the
 * portal, and the code each program adds to the link.
 */
export function CloserLinksPageClient() {
  usePageTitle("Closer links · Booking setup");
  const data = useQuery(api.bookingSetup.closerLinks.listCloserLinks, {});

  if (data === undefined) return <BookingPageSkeleton />;

  return (
    <div className="@container/closer-links flex min-w-0 flex-col gap-3.5">
      <p className="max-w-[680px] text-[13.5px] leading-[20px] text-muted-foreground">
        In the link portal, a DM closer picks a phone closer, then a program. The link opens that phone
        closer’s own Calendly page and carries the program’s code as{" "}
        <code className="font-mono text-[12.5px] text-foreground" translate="no">
          utm_content
        </code>
        , so the booking lands on the right program.
      </p>
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] items-start gap-3.5 @[64rem]/closer-links:grid-cols-[minmax(0,1fr)_340px]">
        <CloserLinksCard closers={data.closers} />
        <ProgramLinkCodesCard programs={data.programs} />
      </div>
    </div>
  );
}
