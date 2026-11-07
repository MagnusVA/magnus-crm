import { Skeleton } from "@/components/ui/skeleton";

/** What sits under the band while a section loads: one card of rows. */
export function BookingPageSkeleton() {
  return (
    <div role="status" aria-label="Loading booking setup">
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="h-11 border-b border-border" />
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="flex h-[88px] items-center gap-4 border-b border-border px-4 last:border-b-0">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 flex-1" />
          </div>
        ))}
      </div>
    </div>
  );
}
