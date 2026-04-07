import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function SettingsLoading() {
	return (
		<div className="flex flex-col gap-6" role="status" aria-label="Loading settings">
			{/* Page header */}
			<div className="flex flex-col gap-2">
				<Skeleton className="h-9 w-32" />
				<Skeleton className="h-5 w-64" />
			</div>

			{/* Tabs bar */}
			<Skeleton className="h-10 w-56 rounded-lg" />

			{/* Tab content — settings cards */}
			{Array.from({ length: 2 }).map((_, i) => (
				<Card key={i}>
					<CardHeader>
						<Skeleton className="h-6 w-40" />
						<Skeleton className="h-4 w-64" />
					</CardHeader>
					<CardContent>
						<Skeleton className="h-24 w-full" />
					</CardContent>
				</Card>
			))}
		</div>
	);
}
