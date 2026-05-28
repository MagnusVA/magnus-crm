import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function OverviewDashboardSkeleton() {
	return (
		<div
			className="mx-auto flex w-full max-w-[1500px] flex-col gap-5"
			role="status"
			aria-label="Loading overview dashboard"
		>
			<div className="flex flex-col gap-3 border-b pb-4 lg:flex-row lg:items-end lg:justify-between">
				<div className="flex flex-col gap-2">
					<Skeleton className="h-8 w-44" />
					<Skeleton className="h-4 w-64 max-w-full" />
				</div>
				<Skeleton className="h-9 w-72 max-w-full" />
			</div>
			<div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
				{Array.from({ length: 3 }).map((_, index) => (
					<Card key={index} size="sm">
						<CardHeader>
							<Skeleton className="h-5 w-36" />
							<Skeleton className="h-4 w-52 max-w-full" />
						</CardHeader>
						<CardContent className="flex flex-col gap-3">
							<Skeleton className="h-12 w-full" />
							<Skeleton className="h-24 w-full" />
						</CardContent>
					</Card>
				))}
			</div>
			<Skeleton className="h-[360px] w-full rounded-lg" />
			<Skeleton className="h-[320px] w-full rounded-lg" />
		</div>
	);
}
