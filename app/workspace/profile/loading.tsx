import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/** The profile while it loads: the navy band, then the dense card's rows. */
export default function ProfileLoading() {
	return (
		<div
			className="@container mx-auto flex w-full max-w-[640px] flex-col gap-3.5 pb-6 short:gap-3"
			role="status"
			aria-label="Loading your profile"
		>
			<div className="rounded-xl bg-board px-4 py-3.5 @lg:px-[18px] @lg:py-4 dark:ring-1 dark:ring-board-foreground/10">
				<Skeleton className="h-7 w-40 bg-board-raised" />
				<Skeleton className="mt-1.5 h-4 w-72 max-w-full bg-board-raised" />
			</div>
			<Card className="w-full gap-0 py-0">
				<div className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-x-3 px-4 py-3">
					<Skeleton className="h-3.5 w-12" />
					<div className="flex flex-col gap-1.5">
						<div className="flex items-center gap-2">
							<Skeleton className="mr-1 size-10 rounded-full" />
							<Skeleton className="h-7 w-24" />
						</div>
						<Skeleton className="h-4 w-48" />
					</div>
				</div>
				{[2, 2].map((rows, group) => (
					<div key={group} className="border-t py-1">
						{Array.from({ length: rows }, (_, row) => (
							<div
								key={row}
								className="grid min-h-8 grid-cols-[6rem_minmax(0,1fr)] items-center gap-x-3 px-4 py-1.5"
							>
								<Skeleton className="h-3.5 w-14" />
								<Skeleton className="h-4 w-40 max-w-full" />
							</div>
						))}
					</div>
				))}
			</Card>
		</div>
	);
}
