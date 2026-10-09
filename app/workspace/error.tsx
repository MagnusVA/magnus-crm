"use client";

import { useEffect } from "react";
import { reportErrorBoundary } from "@/lib/observability/report-client-error";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertTriangleIcon, RefreshCwIcon } from "lucide-react";

export default function WorkspaceError({
	error,
	retry,
}: {
	error: Error & { digest?: string };
	retry: () => void;
}) {
	useEffect(() => {
		console.error("[WorkspaceError]", error);
		reportErrorBoundary(error, { boundary: "workspace" });
	}, [error]);

	return (
		<div
			className="flex min-h-[50vh] items-center justify-center p-6"
			role="alert"
			aria-live="assertive"
		>
			<Card className="w-full max-w-md">
				<CardHeader className="text-center">
					<div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-destructive/10">
						<AlertTriangleIcon className="size-6 text-destructive" />
					</div>
					<CardTitle>Something went wrong</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-col items-center gap-4">
					<p className="text-center text-sm text-muted-foreground">
						An unexpected error occurred while loading this page.
						{error.digest && (
							<span className="mt-1 block font-mono text-xs">
								Error ID: {error.digest}
							</span>
						)}
					</p>
					<Button onClick={() => retry()} variant="outline" size="sm">
						<RefreshCwIcon data-icon="inline-start" />
						Try again
					</Button>
				</CardContent>
			</Card>
		</div>
	);
}
