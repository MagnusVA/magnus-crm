"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ChevronDownIcon, InboxIcon, SearchIcon } from "lucide-react";
import {
	Card,
	CardAction,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const SEARCH_DEBOUNCE_MS = 300;

export type OpsSearchableListProps = {
	title: string;
	searchPlaceholder: string;
	/** Committed (debounced) search value — safe to send to queries. */
	searchValue: string;
	/** Called ~300ms after the user stops typing. */
	onSearchChange: (value: string) => void;
	isLoading?: boolean;
	/**
	 * When set (and not loading), an empty state replaces `children`.
	 * Pass it only when the list has no rows to show.
	 */
	emptyMessage?: string;
	children: ReactNode;
	/** Optional slot rendered at the top-right of the card header. */
	headerRight?: ReactNode;
	className?: string;
};

function OpsListSkeleton({ title }: { title: string }) {
	return (
		<div
			className="flex flex-col gap-2"
			role="status"
			aria-label={`Loading ${title}`}
		>
			<Skeleton className="h-11 w-full" />
			<Skeleton className="h-11 w-full" />
			<Skeleton className="h-11 w-full" />
			<Skeleton className="h-11 w-full" />
		</div>
	);
}

/**
 * Card shell for the searchable, collapsible detail lists on the operations
 * pages (submissions, bookings, sales-call views). Debounces the search input
 * internally; compose rows with `OpsCollapsibleRow`.
 */
export function OpsSearchableList({
	title,
	searchPlaceholder,
	searchValue,
	onSearchChange,
	isLoading = false,
	emptyMessage,
	children,
	headerRight,
	className,
}: OpsSearchableListProps) {
	const [draft, setDraft] = useState(searchValue);

	useEffect(() => {
		setDraft(searchValue);
	}, [searchValue]);

	useEffect(() => {
		const timeout = window.setTimeout(
			() => onSearchChange(draft),
			SEARCH_DEBOUNCE_MS,
		);
		return () => window.clearTimeout(timeout);
	}, [draft, onSearchChange]);

	return (
		<Card className={className}>
			<CardHeader>
				<CardTitle>{title}</CardTitle>
				{headerRight ? <CardAction>{headerRight}</CardAction> : null}
			</CardHeader>
			<CardContent className="flex flex-col gap-3">
				<div className="relative w-full lg:max-w-md">
					<SearchIcon
						className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
						aria-hidden="true"
					/>
					<Input
						value={draft}
						onChange={(event) => setDraft(event.target.value)}
						placeholder={searchPlaceholder}
						aria-label={searchPlaceholder}
						className="pl-9"
					/>
				</div>
				{isLoading ? (
					<OpsListSkeleton title={title} />
				) : emptyMessage ? (
					<Empty className="min-h-[160px] border p-4">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<InboxIcon aria-hidden="true" />
							</EmptyMedia>
							<EmptyTitle>Nothing here</EmptyTitle>
							<EmptyDescription>{emptyMessage}</EmptyDescription>
						</EmptyHeader>
					</Empty>
				) : (
					<div className="flex max-h-[520px] flex-col gap-2 overflow-y-auto pr-1">
						{children}
					</div>
				)}
			</CardContent>
		</Card>
	);
}

export type OpsCollapsibleRowProps = {
	/** Always-visible row content (left of the chevron). */
	summary: ReactNode;
	/** Expanded detail content. */
	children: ReactNode;
	defaultOpen?: boolean;
	className?: string;
};

/**
 * Collapsible row primitive for `OpsSearchableList`: a keyboard-accessible
 * trigger row with a rotating chevron and a subtly tinted detail area.
 */
export function OpsCollapsibleRow({
	summary,
	children,
	defaultOpen = false,
	className,
}: OpsCollapsibleRowProps) {
	return (
		<Collapsible
			defaultOpen={defaultOpen}
			className={cn(
				"group/ops-row rounded-lg border bg-card",
				className,
			)}
		>
			<CollapsibleTrigger className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring group-data-[state=open]/ops-row:rounded-b-none">
				<div className="min-w-0 flex-1">{summary}</div>
				<ChevronDownIcon
					className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=open]/ops-row:rotate-180"
					aria-hidden="true"
				/>
			</CollapsibleTrigger>
			<CollapsibleContent>
				<div className="rounded-b-lg border-t bg-muted/30 px-3 py-3 text-sm">
					{children}
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}
