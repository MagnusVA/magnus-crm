import { Skeleton } from "@/components/ui/skeleton";

export function PayPageSkeleton() {
	return (
		<div
			role="status"
			aria-label="Loading the payment"
			className="mx-auto flex w-full max-w-md flex-col gap-4"
		>
			<Skeleton className="h-7 w-40" />
			<Skeleton className="h-56 w-full rounded-xl" />
			<Skeleton className="h-36 w-full rounded-xl" />
			<Skeleton className="h-11 w-full" />
		</div>
	);
}
