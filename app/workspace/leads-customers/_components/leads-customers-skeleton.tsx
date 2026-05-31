import { Skeleton } from "@/components/ui/skeleton";

export function LeadsCustomersSkeleton() {
	return (
		<div
			className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8"
			role="status"
			aria-label="Loading leads and customers workspace"
		>
			<div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
				<div className="flex min-w-0 flex-col gap-2">
					<Skeleton className="h-7 w-56 max-w-full" />
					<Skeleton className="h-4 w-80 max-w-full" />
				</div>
				<Skeleton className="h-7 w-32" />
			</div>
			<div className="rounded-md border p-3">
				<div className="flex flex-col gap-3 lg:flex-row lg:items-center">
					<Skeleton className="h-9 min-w-0 flex-1" />
					<Skeleton className="h-8 w-56 max-w-full" />
				</div>
			</div>
			<div className="rounded-md border">
				{Array.from({ length: 8 }).map((_, index) => (
					<div
						key={index}
						className="grid grid-cols-[minmax(0,1.6fr)_8rem_minmax(0,1fr)_8rem] gap-4 border-b p-3 last:border-b-0"
					>
						<Skeleton className="h-5 min-w-0" />
						<Skeleton className="h-5 w-20" />
						<Skeleton className="h-5 min-w-0" />
						<Skeleton className="h-5 w-24 justify-self-end" />
					</div>
				))}
			</div>
		</div>
	);
}
