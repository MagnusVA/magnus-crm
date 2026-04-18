"use client";

import { useEffect } from "react";
import posthog from "posthog-js";
import { AlertCircleIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/**
 * Route-level error boundary for the reminder detail page.
 *
 * App Router requires error boundaries to be client components — they need
 * the `reset` function passed to them. On mount we report the error to
 * PostHog so we can monitor real-world error rates on this route, then
 * render a calm, actionable recovery UI.
 */
export default function ReminderDetailError({
	error,
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	useEffect(() => {
		posthog.captureException(error, {
			route: "/workspace/closer/reminders/[followUpId]",
			digest: error.digest,
		});
	}, [error]);

	return (
		<div className="flex flex-col items-center gap-4 py-12">
			<Alert variant="destructive" className="max-w-md">
				<AlertCircleIcon />
				<AlertTitle>Something went wrong</AlertTitle>
				<AlertDescription>
					We couldn&apos;t load this reminder. The error has been reported.
				</AlertDescription>
			</Alert>
			<Button onClick={reset}>Try again</Button>
		</div>
	);
}
