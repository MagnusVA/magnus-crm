"use client";

import Link from "next/link";
import { usePageTitle } from "@/hooks/use-page-title";
import { BOOKING_ROOT, BookingBand } from "./booking-band";
import { CampaignPresetsCard } from "./campaign-presets-card";
import { PortalAccessCard } from "./portal-access-card";
import { PortalUsageCard } from "./portal-usage-card";

export function PortalPageClient() {
  usePageTitle("Link portal");

  return (
    <div className={BOOKING_ROOT}>
      <BookingBand
        description={
          <>
            Where DM closers copy their booking links. What each team can book is set on{" "}
            <Link
              href="/workspace/booking"
              className="font-semibold text-board-foreground underline decoration-board-foreground/40 underline-offset-2 hover:decoration-board-foreground"
            >
              Coverage
            </Link>
            .
          </>
        }
      />
      <div className="grid gap-3.5 short:gap-3 @5xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] @5xl:items-start">
        <div className="flex min-w-0 flex-col gap-3.5 short:gap-3">
          <PortalAccessCard />
          <CampaignPresetsCard />
        </div>
        <PortalUsageCard />
      </div>
    </div>
  );
}
