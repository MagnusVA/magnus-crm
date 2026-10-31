import { Skeleton } from "@/components/ui/skeleton";
import { DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { DealModalHeaderFrame } from "./deal-modal-header";

/**
 * The open modal while its deal loads, at the real heights: the header,
 * the stage track and credit line, the next step, and two call rows.
 */
export function DealModalSkeleton() {
	return (
		<>
			<DealModalHeaderFrame>
				<DialogTitle className="sr-only">Loading the deal</DialogTitle>
				<DialogDescription className="sr-only">
					The deal&apos;s stage, next step, calls and payments are loading.
				</DialogDescription>
				<div className="flex items-center gap-2.5" aria-hidden="true">
					<Skeleton className="h-[1.375rem] w-44" />
					<Skeleton className="h-5 w-16 rounded" />
				</div>
				<Skeleton className="mt-1.5 h-4 w-72 max-w-full" aria-hidden="true" />
			</DealModalHeaderFrame>
			<div
				className="min-h-0 flex-1 overflow-hidden"
				role="status"
				aria-label="Loading the deal"
			>
				<div className="grid grid-cols-4 px-3 pt-4 pb-1 sm:px-5">
					{Array.from({ length: 4 }, (_, index) => (
						<div key={index} className="flex flex-col items-center gap-1.5">
							<Skeleton className="size-4 rounded-full" />
							<Skeleton className="h-3 w-14" />
						</div>
					))}
				</div>
				<div className="px-4 pt-2 pb-3.5 sm:px-5">
					<Skeleton className="h-4 w-64 max-w-full" />
				</div>
				<SkeletonSection>
					<div className="flex min-h-13 items-center justify-between gap-4 px-4 py-2.5 sm:px-5">
						<Skeleton className="h-5 w-40" />
						<Skeleton className="h-7 w-32" />
					</div>
				</SkeletonSection>
				<SkeletonSection>
					{Array.from({ length: 2 }, (_, index) => (
						<div
							key={index}
							className="flex min-h-11 items-center justify-between gap-4 border-t px-4 first:border-t-0 sm:px-5"
						>
							<Skeleton className="h-4 w-36" />
							<Skeleton className="h-3.5 w-16" />
						</div>
					))}
				</SkeletonSection>
			</div>
		</>
	);
}

function SkeletonSection({ children }: { children: React.ReactNode }) {
	return (
		<div className="border-t">
			<div className="flex min-h-11 items-center border-b px-4 sm:px-5">
				<Skeleton className="h-4 w-20" />
			</div>
			{children}
		</div>
	);
}
