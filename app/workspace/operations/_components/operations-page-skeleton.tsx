import { Skeleton } from "@/components/ui/skeleton";

export function OperationsPageSkeleton() {
  return (
    <div
      className="flex flex-col gap-6"
      role="status"
      aria-label="Loading operations"
    >
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <Skeleton className="h-9 w-96 max-w-full" />
      <Skeleton className="h-[420px] w-full" />
    </div>
  );
}
