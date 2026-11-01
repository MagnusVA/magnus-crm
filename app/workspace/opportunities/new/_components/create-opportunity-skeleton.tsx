import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/** The New side deal page while it loads: the navy band, then the form card. */
export function CreateOpportunitySkeleton() {
	return (
		<div
			className="@container mx-auto flex w-full max-w-[640px] flex-col gap-3.5 pb-6 short:gap-3"
			role="status"
			aria-label="Loading the new side deal form"
		>
			<div className="rounded-xl bg-board px-4 py-3.5 @lg:px-[18px] @lg:py-4 dark:ring-1 dark:ring-board-foreground/10">
				<Skeleton className="mb-1.5 h-6 w-36 bg-board-raised" />
				<Skeleton className="h-7 w-48 bg-board-raised" />
				<Skeleton className="mt-1.5 h-4 w-full max-w-md bg-board-raised" />
			</div>
			<Card className="w-full gap-0 py-0">
				<div className="flex min-h-11 items-center justify-between border-b px-4 py-2">
					<Skeleton className="h-4 w-16" />
					<Skeleton className="h-7 w-32" />
				</div>
				<div className="flex flex-col gap-1.5 px-4 py-3">
					<Skeleton className="h-8 w-full" />
					<Skeleton className="h-4 w-64 max-w-full" />
				</div>
				<div className="flex min-h-11 items-center border-y px-4 py-2">
					<Skeleton className="h-4 w-14" />
				</div>
				<div className="px-4 py-3">
					<Skeleton className="h-24 w-full" />
				</div>
				<div className="flex justify-end gap-2 border-t bg-background px-4 py-3">
					<Skeleton className="h-8 w-20" />
					<Skeleton className="h-8 w-36" />
				</div>
			</Card>
		</div>
	);
}
