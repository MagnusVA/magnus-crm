import { Skeleton } from "@/components/ui/skeleton";

export function BillingPageSkeleton({ detail = false }: { detail?: boolean }) {
  return (
    <div
      aria-label={detail ? "Loading billing payment" : "Loading billing queue"}
      className="flex flex-col gap-4"
      role="status"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-2">
          <Skeleton className="h-8 w-44" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <Skeleton className="h-8 w-28" />
      </div>
      {detail ? (
        <>
          <Skeleton className="h-64 w-full" />
          <div className="grid gap-4 lg:grid-cols-2">
            <Skeleton className="h-72 w-full" />
            <Skeleton className="h-72 w-full" />
          </div>
          <Skeleton className="h-52 w-full" />
        </>
      ) : (
        <>
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-[460px] w-full" />
        </>
      )}
    </div>
  );
}
