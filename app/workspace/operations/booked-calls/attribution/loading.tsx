import { Skeleton } from "@/components/ui/skeleton";

export default function AttributionLoading() {
  return (
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-3.5 pb-6" role="status" aria-label="Loading attribution checks">
      <Skeleton className="h-[104px] rounded-xl" />
      <Skeleton className="h-64 rounded-xl" />
    </div>
  );
}
