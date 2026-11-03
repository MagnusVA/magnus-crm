"use client";

import { usePageTitle } from "@/hooks/use-page-title";
import { AttributionRegistry } from "./attribution-registry";
import { AttributionUnmappedPanel } from "./attribution-unmapped-panel";
import { BOOKING_ROOT, BookingBand } from "./booking-band";

export function TeamsPageClient() {
  usePageTitle("DM teams");

  return (
    <div className={BOOKING_ROOT}>
      <BookingBand description="DM teams and their DM closers. Their UTM values credit bookings; which links each team gets is on Coverage." />
      <AttributionRegistry />
      <AttributionUnmappedPanel />
    </div>
  );
}
