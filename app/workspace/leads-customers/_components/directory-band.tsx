"use client";

import { useEffect, useRef, type KeyboardEvent, type RefObject } from "react";
import Link from "next/link";
import { PlusIcon, SearchIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PageBand } from "@/app/workspace/_components/page-band";
import { useEntityBrowser, type EntityLifecycleFilter } from "./entity-browser-context";

export const RESULTS_ID = "people-results";

export const LIFECYCLE_TABS: Array<{ value: EntityLifecycleFilter; label: string }> = [
	{ value: "all", label: "All" },
	{ value: "lead", label: "Leads" },
	{ value: "customer", label: "Customers" },
	{ value: "prospect", label: "Prospects" },
];

export function tabId(value: EntityLifecycleFilter) {
	return `people-tab-${value}`;
}

/**
 * The page's navy band, the strips' sibling: the title and New side deal,
 * the search field (the page's hero, focused on load, `/` to return to it,
 * Escape to clear), and the lifecycle tabs with what the list shows.
 */
export function DirectoryBand({
	inputRef,
	summary,
	browsing,
}: {
	inputRef: RefObject<HTMLInputElement | null>;
	/** "Newest activity first", or "3 matches for “ana”". */
	summary: string | null;
	/** No search typed: the summary is the order, not a count. */
	browsing: boolean;
}) {
	return (
		<PageBand
			title="Leads & Customers"
			titleId="people-title"
			description="Find anyone by name, phone, email, handle or ID"
			actions={
				<Button asChild className="font-semibold">
					<Link href="/workspace/leads-customers/new-opportunity">
						<PlusIcon data-icon="inline-start" aria-hidden="true" />
						New side deal
					</Link>
				</Button>
			}
		>
			<SearchField inputRef={inputRef} />

			<div className="-mx-4 flex flex-wrap items-center gap-x-4 border-t border-board-line px-4 @lg:-mx-[18px] @lg:px-[18px]">
				<LifecycleTabs />
				<p
					aria-live="polite"
					className={cn(
						"ml-auto py-2 text-[13px] text-board-muted tabular-nums",
						// Browsing, the order line is only a note; on a phone it would
						// take a line of its own. The match count always shows.
						browsing && "hidden @md:block",
					)}
				>
					{summary}
				</p>
			</div>
		</PageBand>
	);
}

function isTypingTarget(target: EventTarget | null) {
	if (!(target instanceof HTMLElement)) return false;
	if (target.isContentEditable) return true;
	if (target.closest("[role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox']")) return true;
	return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function SearchField({ inputRef }: { inputRef: RefObject<HTMLInputElement | null> }) {
	const { state, actions } = useEntityBrowser();

	// The cursor starts in the field, except on touch screens, where focusing
	// would open the keyboard over the list.
	useEffect(() => {
		if (window.matchMedia("(pointer: coarse)").matches) return;
		inputRef.current?.focus({ preventScroll: true });
	}, [inputRef]);

	// "/" returns to the field from anywhere that isn't taking text.
	useEffect(() => {
		function onKeyDown(event: globalThis.KeyboardEvent) {
			if (event.key !== "/" || event.defaultPrevented) return;
			if (event.metaKey || event.ctrlKey || event.altKey) return;
			if (isTypingTarget(event.target)) return;
			event.preventDefault();
			inputRef.current?.focus();
			inputRef.current?.select();
		}
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [inputRef]);

	const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Escape" && state.query !== "") {
			event.preventDefault();
			actions.setQuery("");
		}
	};

	return (
		<div className="flex h-11 items-center gap-2.5 rounded-[7px] border border-board-foreground/15 bg-board-raised px-3.5 transition-[color,box-shadow] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
			<SearchIcon className="size-4 shrink-0 text-board-muted" aria-hidden="true" />
			<input
				ref={inputRef}
				type="search"
				name="people-search"
				value={state.query}
				onChange={(event) => actions.setQuery(event.target.value)}
				onKeyDown={onInputKeyDown}
				placeholder="Search people…"
				aria-label="Search people by name, phone, email, handle or ID"
				aria-controls={RESULTS_ID}
				aria-keyshortcuts="/"
				autoComplete="off"
				spellCheck={false}
				className="h-full min-w-0 flex-1 appearance-none bg-transparent text-base text-board-foreground caret-primary-ink outline-none placeholder:text-board-muted [&::-webkit-search-cancel-button]:appearance-none"
			/>
			{state.query !== "" ? (
				<button
					type="button"
					onClick={() => {
						actions.setQuery("");
						inputRef.current?.focus();
					}}
					aria-label="Clear search"
					className="-mr-1.5 inline-flex size-7 shrink-0 items-center justify-center rounded-[5.6px] text-board-muted outline-none hover:bg-board-foreground/10 hover:text-board-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
				>
					<XIcon className="size-4" aria-hidden="true" />
				</button>
			) : (
				<kbd
					aria-hidden="true"
					className="shrink-0 rounded-[4px] border border-board-foreground/20 px-1.5 font-sans text-[11px] leading-4 font-semibold text-board-muted"
				>
					/
				</kbd>
			)}
		</div>
	);
}

/** ALL · LEADS · CUSTOMERS · PROSPECTS, a tablist over the results; arrows move between tabs. */
function LifecycleTabs() {
	const { state, actions } = useEntityBrowser();
	const listRef = useRef<HTMLDivElement>(null);

	const select = (index: number) => {
		const tab = LIFECYCLE_TABS[(index + LIFECYCLE_TABS.length) % LIFECYCLE_TABS.length];
		actions.setLifecycle(tab.value);
		listRef.current?.querySelector<HTMLButtonElement>(`#${tabId(tab.value)}`)?.focus();
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const current = LIFECYCLE_TABS.findIndex((tab) => tab.value === state.lifecycle);
		if (event.key === "ArrowRight") select(current + 1);
		else if (event.key === "ArrowLeft") select(current - 1);
		else if (event.key === "Home") select(0);
		else if (event.key === "End") select(LIFECYCLE_TABS.length - 1);
		else return;
		event.preventDefault();
	};

	return (
		<div
			ref={listRef}
			role="tablist"
			aria-label="Which people"
			onKeyDown={onKeyDown}
			className="flex min-w-0 gap-4 overflow-x-auto [scrollbar-width:none] @xl:gap-[22px]"
		>
			{LIFECYCLE_TABS.map((tab) => {
				const selected = tab.value === state.lifecycle;
				return (
					<button
						key={tab.value}
						id={tabId(tab.value)}
						type="button"
						role="tab"
						aria-selected={selected}
						aria-controls={RESULTS_ID}
						tabIndex={selected ? 0 : -1}
						onClick={() => actions.setLifecycle(tab.value)}
						className={cn(
							"h-10 shrink-0 border-b-2 font-condensed text-[13px] font-semibold tracking-[0.12em] whitespace-nowrap uppercase outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
							selected
								? "border-primary text-board-foreground"
								: "border-transparent text-board-muted hover:text-board-foreground",
						)}
					>
						{tab.label}
					</button>
				);
			})}
		</div>
	);
}
