import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { CELL, ROW_GRID } from "./person-row-grid";

/** The page root: a container, so rows and skeletons fold by the page's width. */
export const PAGE_ROOT =
	"@container mx-auto flex w-full max-w-[1500px] flex-col gap-3.5 pb-6 short:gap-3";

/** The band and ten rows at their real sizes, while the route first loads. */
export function LeadsCustomersSkeleton() {
	return (
		<div className={PAGE_ROOT} role="status" aria-label="Loading leads and customers">
			<div className="flex flex-col gap-3 rounded-xl bg-board px-4 pt-4 @xl:px-[18px] dark:ring-1 dark:ring-board-foreground/10">
				<div className="flex items-center justify-between gap-3.5">
					<div className="flex flex-col gap-2">
						<Skeleton className="h-6 w-56 max-w-full bg-board-raised" />
						<Skeleton className="h-3.5 w-72 max-w-full bg-board-raised" />
					</div>
					<Skeleton className="h-8 w-32 shrink-0 bg-board-raised" />
				</div>
				<div className="h-11 rounded-[7px] border border-board-foreground/15 bg-board-raised" />
				<div className="-mx-4 flex h-10 items-center gap-5 border-t border-board-line px-4 @xl:-mx-[18px] @xl:px-[18px]">
					{["w-8", "w-12", "w-20", "w-[72px]"].map((width) => (
						<Skeleton key={width} className={cn("h-3 bg-board-raised", width)} />
					))}
				</div>
			</div>
			<div className="overflow-hidden rounded-xl border bg-card">
				<PeopleRowsSkeleton />
			</div>
		</div>
	);
}

/** Rows at the real row heights for each container step; labelled only when it stands alone. */
export function PeopleRowsSkeleton({ label }: { label?: string }) {
	return (
		<div role={label ? "status" : undefined} aria-label={label}>
			{Array.from({ length: 10 }).map((_, index) => (
				<div key={index} className={cn(ROW_GRID, "border-t first:border-t-0")}>
					<div className={cn(CELL.person, "flex flex-col gap-1.5")}>
						<Skeleton className="h-4 w-40 max-w-full" />
						<Skeleton className="h-3 w-52 max-w-full" />
					</div>
					<div className={cn(CELL.money, "flex flex-col items-end gap-1.5")}>
						<Skeleton className="h-4 w-14" />
						<Skeleton className="h-2.5 w-10" />
					</div>
					<div className={cn(CELL.deal, "flex flex-col gap-1.5")}>
						<Skeleton className="h-4 w-36 max-w-full" />
						<Skeleton className="h-3 w-24" />
					</div>
					<div className={cn(CELL.next, "flex flex-col gap-1.5")}>
						<Skeleton className="h-4 w-32 max-w-full" />
						<Skeleton className="h-3 w-28" />
					</div>
				</div>
			))}
		</div>
	);
}
