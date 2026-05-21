import { Skeleton } from "@/components/ui/skeleton";

export default function DmLinksLoading() {
	return (
		<main
			className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-4 p-4 md:p-8"
			role="status"
			aria-label="Loading DM link portal…"
		>
			<Skeleton className="h-10 w-64" />
			<Skeleton className="h-96 w-full" />
		</main>
	);
}
