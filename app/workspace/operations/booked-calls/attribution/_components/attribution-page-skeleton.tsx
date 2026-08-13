import { Skeleton } from "@/components/ui/skeleton";

export function AttributionPageSkeleton() {
  return (
    <div
      className="flex min-w-0 flex-col gap-4"
      role="status"
      aria-label="Loading attribution"
    >
      <header className="flex flex-col gap-4 border-b pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-[3px] h-7 w-[3px] shrink-0 rounded-full bg-primary/40" />
          <div className="flex flex-col gap-2">
            <Skeleton className="h-7 w-40" />
            <Skeleton className="h-4 w-80 max-w-full" />
          </div>
        </div>
        <Skeleton className="h-8 w-32" />
      </header>
      <Skeleton className="h-9 w-96 max-w-full" />
      <div className="grid gap-4 xl:grid-cols-2">
        <Skeleton className="h-72 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
    </div>
  );
}
