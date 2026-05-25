import { Skeleton } from "@/components/ui/skeleton";

export function LeadGenSettingsSkeleton() {
  return (
    <div
      className="flex flex-col gap-6"
      role="status"
      aria-label="Loading Lead Gen Ops settings"
    >
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <Skeleton className="h-8 w-80 max-w-full" />
      <Skeleton className="h-[360px] w-full" />
    </div>
  );
}
