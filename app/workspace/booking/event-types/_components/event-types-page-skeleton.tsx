import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { ROW_GRID } from "./event-types-parts";

/** Event types while they load: the tools row, the sync line and ten table rows. */
export function EventTypesPageSkeleton() {
  return (
    <div role="status" aria-label="Loading event types" className="@container/et overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex min-h-[46px] items-center gap-4 border-b border-border px-4">
        <Skeleton className="h-8 w-60" />
        <Skeleton className="h-4 w-96 max-w-[40%]" />
      </div>
      <div className="flex h-[38px] items-center border-b border-border bg-background px-4">
        <Skeleton className="h-3.5 w-[28rem] max-w-[70%]" />
      </div>
      <div className="h-[30px] border-b border-border" />
      {Array.from({ length: 10 }, (_, index) => (
        <div key={index} className={cn(ROW_GRID, "min-h-[47px] border-b border-border last:border-b-0")}>
          <Skeleton className="size-4" />
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-3.5 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
          <Skeleton className="h-3.5 w-3/4" />
          <Skeleton className="ml-auto h-4 w-6" />
        </div>
      ))}
    </div>
  );
}
