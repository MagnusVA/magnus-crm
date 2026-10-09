"use client";

import { useEffect } from "react";
import { reportErrorBoundary } from "@/lib/observability/report-client-error";
import "./globals.css";

/**
 * Replaces the root layout when it throws. It renders its own document, so
 * it can't use the app's providers or theme.
 */
export default function GlobalError({
	error,
	retry,
}: {
	error: Error & { digest?: string };
	retry: () => void;
}) {
	useEffect(() => {
		reportErrorBoundary(error, {
			boundary: "global",
			origin: "next_global_error_boundary",
		});
	}, [error]);

	return (
		<html lang="en">
			<body className="flex min-h-screen items-center justify-center p-6 font-sans antialiased">
				<main
					className="flex max-w-md flex-col items-center gap-4 text-center"
					role="alert"
					aria-live="assertive"
				>
					<h1 className="text-lg font-semibold">Something went wrong</h1>
					<p className="text-sm text-muted-foreground">
						The app hit an unexpected error. It has been reported.
						{error.digest && (
							<span className="mt-1 block font-mono text-xs">
								Error ID: {error.digest}
							</span>
						)}
					</p>
					<button
						type="button"
						onClick={() => retry()}
						className="rounded-md border px-3 py-1.5 text-sm"
					>
						Try again
					</button>
				</main>
			</body>
		</html>
	);
}
