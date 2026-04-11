import { Skeleton } from "@/components/ui/skeleton";

export default function RedistributeLoading() {
	return (
		<div className="flex flex-col gap-6" role="status" aria-label="Loading redistribution wizard">
			<div className="space-y-2">
				<Skeleton className="h-8 w-64" />
				<Skeleton className="h-4 w-96" />
			</div>
			<div className="flex items-center gap-2">
				<Skeleton className="h-6 w-20 rounded-full" />
				<Skeleton className="h-4 w-4" />
				<Skeleton className="h-6 w-24 rounded-full" />
				<Skeleton className="h-4 w-4" />
				<Skeleton className="h-6 w-22 rounded-full" />
			</div>
			<Skeleton className="h-px w-full" />
			<Skeleton className="h-[400px] w-full rounded-xl" />
		</div>
	);
}
