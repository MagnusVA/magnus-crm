import { Skeleton } from "@/components/ui/skeleton";

export function CloserDashboardSkeleton() {
	return (
		<div
			className="mx-auto flex w-full max-w-[1500px] flex-col gap-4 pb-6"
			role="status"
			aria-label="Loading dashboard"
		>
			<header className="flex flex-col gap-3 border-b pb-4 lg:flex-row lg:items-end lg:justify-between">
				<div className="flex min-w-0 items-start gap-3">
					<Skeleton className="mt-[3px] h-7 w-[3px] shrink-0 rounded-full" />
					<div className="flex min-w-0 flex-col gap-2">
						<Skeleton className="h-8 w-48" />
						<Skeleton className="h-4 w-64 max-w-full" />
					</div>
				</div>
				<Skeleton className="h-9 w-72 max-w-full rounded-lg" />
			</header>

			<div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,340px),1fr))] gap-3">
				<Skeleton className="h-[180px] rounded-xl" />
				<Skeleton className="h-[180px] rounded-xl" />
			</div>

			<section className="flex flex-col gap-3 rounded-xl bg-card p-3 ring-1 ring-foreground/10">
				<div className="flex flex-wrap items-center justify-between gap-2 px-0.5">
					<Skeleton className="h-4 w-40" />
					<Skeleton className="h-4 w-28" />
				</div>

				<div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
					<Skeleton className="col-span-2 h-[78px] rounded-lg sm:col-span-1" />
					<Skeleton className="h-[78px] rounded-lg" />
					<Skeleton className="h-[78px] rounded-lg" />
				</div>

				<div className="flex flex-col gap-2">
					<div className="flex items-center justify-between gap-2 px-0.5">
						<Skeleton className="h-3.5 w-32" />
						<Skeleton className="h-3.5 w-12" />
					</div>
					<Skeleton className="h-3 w-full rounded-full" />
					<div className="flex flex-wrap gap-x-3 gap-y-1">
						{Array.from({ length: 7 }).map((_, i) => (
							<Skeleton key={i} className="h-3.5 w-20 rounded" />
						))}
					</div>
				</div>
			</section>

			<div className="min-w-0">
				<div className="mb-2 flex flex-col gap-1">
					<Skeleton className="h-7 w-32" />
					<Skeleton className="h-3 w-80 max-w-full" />
				</div>
				<Skeleton className="h-[400px] rounded-xl" />
			</div>
		</div>
	);
}
