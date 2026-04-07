import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function ProfileLoading() {
	return (
		<div
			className="mx-auto flex max-w-2xl flex-col gap-6"
			role="status"
			aria-label="Loading profile"
		>
			{/* Page header */}
			<div className="flex flex-col gap-2">
				<Skeleton className="h-8 w-32" />
				<Skeleton className="h-4 w-48" />
			</div>

			{/* Account card */}
			<Card>
				<CardHeader>
					<Skeleton className="h-6 w-24" />
					<Skeleton className="h-4 w-72" />
				</CardHeader>
				<CardContent>
					<div className="flex flex-col gap-4">
						<Skeleton className="h-10 w-full" />
						<Skeleton className="h-px w-full" />
						<Skeleton className="h-10 w-full" />
						<Skeleton className="h-px w-full" />
						<Skeleton className="h-10 w-2/3" />
						<Skeleton className="h-px w-full" />
						<Skeleton className="h-10 w-1/2" />
					</div>
				</CardContent>
			</Card>
		</div>
	);
}
