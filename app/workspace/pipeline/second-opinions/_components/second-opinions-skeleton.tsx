import { Skeleton } from "@/components/ui/skeleton";
export function SecondOpinionsSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading second opinions"
      className="flex flex-col gap-5"
    >
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-10 w-80" />
      <Skeleton className="h-72 w-full" />
    </div>
  );
}
