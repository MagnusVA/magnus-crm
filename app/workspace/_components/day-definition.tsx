"use client";
import { useBusinessDay } from "@/hooks/use-business-day";
import { businessDayDisclosure, BUSINESS_DAY_REBUILD_MESSAGE } from "@/lib/businessDay";

export function DayDefinition({ browser = false, bucketKind = "meetings" }: { browser?: boolean; bucketKind?: "meetings" | "lead-gen" }) {
  const { setting, rebuilding } = useBusinessDay(bucketKind);
  return <div className="flex flex-col gap-1 text-xs text-muted-foreground">
    <p>{browser ? "Days follow your browser's time zone" : businessDayDisclosure(setting)}</p>
    {rebuilding && <p role="status">{BUSINESS_DAY_REBUILD_MESSAGE}</p>}
  </div>;
}

export function BusinessDayRebuildingState() {
  return <p role="status" className="rounded-md border p-4 text-sm text-muted-foreground">
    {BUSINESS_DAY_REBUILD_MESSAGE}
  </p>;
}
