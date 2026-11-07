import { Suspense } from "react";
import { requireRole } from "@/lib/auth";
import { BookingBand } from "./_components/booking-band";
import { BOOKING_ROOT_CLASS } from "./_components/booking-layout";
import { BookingPageSkeleton } from "./_components/booking-page-skeleton";

export const unstable_instant = false;

/**
 * Booking setup's sections share one band, rendered here so it stays mounted
 * while the tabs change; each page renders only what sits under it.
 */
export default function BookingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={BOOKING_ROOT_CLASS}>
      <Suspense
        fallback={
          <>
            <div className="h-[133px] rounded-xl bg-board" aria-hidden />
            <BookingPageSkeleton />
          </>
        }
      >
        <AdminOnly>
          <BookingBand />
          {children}
        </AdminOnly>
      </Suspense>
    </div>
  );
}

async function AdminOnly({ children }: { children: React.ReactNode }) {
  await requireRole(["tenant_master", "tenant_admin"]);
  return <>{children}</>;
}
