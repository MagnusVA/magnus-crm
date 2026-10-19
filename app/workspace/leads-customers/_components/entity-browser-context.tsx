"use client";

import { createContext, use, type ReactNode } from "react";

// "prospect" lists people below Qualified: lead gen captures and people a
// DM closer is talking to (docs/plans/phase-2-person-first.md §6.2).
export type EntityLifecycleFilter = "all" | "prospect" | "lead" | "customer";

type EntityBrowserState = {
	query: string;
	debouncedQuery: string;
	lifecycle: EntityLifecycleFilter;
	isSearchDebouncing: boolean;
};

type EntityBrowserActions = {
	setQuery: (value: string) => void;
	setLifecycle: (value: EntityLifecycleFilter) => void;
};

export type EntityBrowserContextValue = {
	state: EntityBrowserState;
	actions: EntityBrowserActions;
	isPending: boolean;
};

const EntityBrowserContext =
	createContext<EntityBrowserContextValue | null>(null);

export function EntityBrowserProvider({
	value,
	children,
}: {
	value: EntityBrowserContextValue;
	children: ReactNode;
}) {
	return <EntityBrowserContext value={value}>{children}</EntityBrowserContext>;
}

export function useEntityBrowser() {
	const context = use(EntityBrowserContext);
	if (!context) {
		throw new Error("useEntityBrowser must be used inside EntityBrowserProvider");
	}
	return context;
}
