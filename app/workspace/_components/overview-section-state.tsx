import { AlertCircleIcon, InfoIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
	Empty,
	EmptyContent,
	EmptyHeader,
	EmptyTitle,
} from "@/components/ui/empty";

export function OverviewEmptyState({ message }: { message: string | null }) {
	return (
		<Empty className="py-8">
			<EmptyHeader>
				<EmptyTitle>No activity</EmptyTitle>
			</EmptyHeader>
			<EmptyContent>{message ?? "No activity for this range."}</EmptyContent>
		</Empty>
	);
}

export function OverviewCappedState({ message }: { message: string | null }) {
	return (
		<Alert variant="destructive">
			<AlertCircleIcon aria-hidden="true" />
			<AlertTitle>Range too large</AlertTitle>
			<AlertDescription>
				{message ?? "Narrow the date range to load this section."}
			</AlertDescription>
		</Alert>
	);
}

export function OverviewErrorState({ message }: { message: string | null }) {
	return (
		<Alert variant="destructive">
			<AlertCircleIcon aria-hidden="true" />
			<AlertTitle>Section unavailable</AlertTitle>
			<AlertDescription>
				{message ?? "This section could not be loaded."}
			</AlertDescription>
		</Alert>
	);
}

export function OverviewTruncatedNote() {
	return (
		<Alert>
			<InfoIcon aria-hidden="true" />
			<AlertTitle>Partial data</AlertTitle>
			<AlertDescription>
				This range hit the Slack event cap. Rankings use the available sample.
			</AlertDescription>
		</Alert>
	);
}
