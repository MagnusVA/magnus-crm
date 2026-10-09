"use client";

import { useEffect } from "react";
import { AlertTriangleIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { reportErrorBoundary } from "@/lib/observability/report-client-error";

/**
 * Root segment boundary. Unlike `global-error.tsx`, it renders inside the
 * root layout, so the app's providers, styles, and theme still apply.
 */
export default function RootError({
	error,
	retry,
}: {
	error: Error & { digest?: string };
	retry: () => void;
}) {
	useEffect(() => {
		reportErrorBoundary(error, { boundary: "root" });
	}, [error]);

	return (
		<main
			className="flex min-h-screen items-center justify-center p-6"
			role="alert"
			aria-live="assertive"
		>
			<div className="flex max-w-md flex-col items-center gap-4 text-center">
				<div className="flex size-12 items-center justify-center rounded-full bg-destructive/10">
					<AlertTriangleIcon className="size-6 text-destructive" aria-hidden="true" />
				</div>
				<h1 className="text-lg font-semibold">Something went wrong</h1>
				<p className="text-sm text-muted-foreground">
					The page hit an unexpected error. It has been reported.
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
			</div>
		</main>
	);
}
