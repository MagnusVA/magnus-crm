import { Skeleton } from "@/components/ui/skeleton";

export function EntityDetailSkeleton() {
	return (
		<div
			className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8"
			role="status"
			aria-label="Loading lead or customer detail"
		>
			<Skeleton className="h-7 w-44" />
			<div className="rounded-md border p-4">
				<Skeleton className="h-8 w-72 max-w-full" />
				<Skeleton className="mt-3 h-4 w-full max-w-2xl" />
				<Skeleton className="mt-4 h-12 w-full" />
			</div>
			{Array.from({ length: 6 }).map((_, index) => (
				<div key={index} className="rounded-md border p-4">
					<Skeleton className="h-5 w-40" />
					<Skeleton className="mt-3 h-16 w-full" />
				</div>
			))}
		</div>
	);
}
