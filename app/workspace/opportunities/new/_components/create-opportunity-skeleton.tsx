import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function CreateOpportunitySkeleton() {
	return (
		<div
			className="mx-auto flex w-full max-w-3xl flex-col gap-6"
			role="status"
			aria-label="Loading new opportunity form"
		>
			<div className="flex flex-col gap-2">
				<Skeleton className="h-7 w-40" />
				<Skeleton className="h-8 w-56" />
				<Skeleton className="h-4 w-full max-w-lg" />
			</div>
			{[0, 1].map((index) => (
				<Card key={index}>
					<CardHeader>
						<Skeleton className="h-5 w-32" />
						<Skeleton className="h-4 w-64 max-w-full" />
					</CardHeader>
					<CardContent className="flex flex-col gap-4">
						<Skeleton className="h-8 w-full" />
						<Skeleton className="h-8 w-full" />
					</CardContent>
				</Card>
			))}
		</div>
	);
}
