import { Skeleton } from "@/components/ui/skeleton";

export function EntityDetailSkeleton() {
	return (
		<div
			className="mx-auto flex w-full max-w-352 flex-col gap-5 px-4 py-5 sm:px-6 lg:px-8"
			role="status"
			aria-label="Loading lead or customer detail"
		>
			<div className="rounded-xl bg-card p-4 ring-1 ring-foreground/10 sm:p-5">
				<Skeleton className="h-5 w-40 skeleton-shimmer" />
				<Skeleton className="mt-4 h-9 w-72 max-w-full skeleton-shimmer" />
				<Skeleton className="mt-3 h-4 w-96 max-w-full skeleton-shimmer" />
				<Skeleton className="mt-4 h-16 w-full skeleton-shimmer" />
			</div>
			<div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_21rem] xl:grid-cols-[minmax(0,1fr)_23rem]">
				<div className="flex min-w-0 flex-col gap-5">
					{Array.from({ length: 4 }).map((_, index) => (
						<div
							key={index}
							className="rounded-xl bg-card ring-1 ring-foreground/10"
						>
							<Skeleton className="m-3 h-5 w-32 skeleton-shimmer" />
							<Skeleton className="mx-3 mb-3 h-20 w-[calc(100%-1.5rem)] skeleton-shimmer" />
						</div>
					))}
				</div>
				<div className="flex flex-col gap-5">
					{Array.from({ length: 3 }).map((_, index) => (
						<div
							key={index}
							className="rounded-xl bg-card ring-1 ring-foreground/10"
						>
							<Skeleton className="m-3 h-5 w-28 skeleton-shimmer" />
							<Skeleton className="mx-3 mb-3 h-14 w-[calc(100%-1.5rem)] skeleton-shimmer" />
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
