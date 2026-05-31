"use client";

import {
	createContext,
	use,
	useCallback,
	useEffect,
	useMemo,
	useState,
	type ReactNode,
} from "react";
import type { Id } from "@/convex/_generated/dataModel";

type OpportunitySheetActions = {
	openOpportunity: (opportunityId: Id<"opportunities">) => void;
	closeOpportunity: () => void;
};

type OpportunitySheetContextValue = {
	opportunityId: Id<"opportunities"> | null;
	actions: OpportunitySheetActions;
};

const OpportunitySheetContext =
	createContext<OpportunitySheetContextValue | null>(null);

function readOpportunityIdFromLocation(): Id<"opportunities"> | null {
	if (typeof window === "undefined") return null;
	const value = new URLSearchParams(window.location.search).get("opportunityId");
	return value ? (value as Id<"opportunities">) : null;
}

function syncOpportunityIdInUrl(opportunityId: Id<"opportunities"> | null) {
	if (typeof window === "undefined") return;
	const url = new URL(window.location.href);
	if (opportunityId) {
		url.searchParams.set("opportunityId", opportunityId);
	} else {
		url.searchParams.delete("opportunityId");
	}
	const next = `${url.pathname}${url.search}${url.hash}`;
	window.history.replaceState(window.history.state, "", next);
}

export function OpportunitySheetProvider({ children }: { children: ReactNode }) {
	const [opportunityId, setOpportunityId] = useState<Id<"opportunities"> | null>(
		null,
	);

	useEffect(() => {
		const fromUrl = readOpportunityIdFromLocation();
		if (fromUrl) setOpportunityId(fromUrl);
	}, []);

	const openOpportunity = useCallback((id: Id<"opportunities">) => {
		setOpportunityId(id);
	}, []);

	const closeOpportunity = useCallback(() => {
		setOpportunityId(null);
		syncOpportunityIdInUrl(null);
	}, []);

	const value = useMemo(
		() => ({
			opportunityId,
			actions: { openOpportunity, closeOpportunity },
		}),
		[closeOpportunity, openOpportunity, opportunityId],
	);

	return (
		<OpportunitySheetContext value={value}>{children}</OpportunitySheetContext>
	);
}

export function useOpportunitySheet() {
	const context = use(OpportunitySheetContext);
	if (!context) {
		throw new Error(
			"useOpportunitySheet must be used inside OpportunitySheetProvider",
		);
	}
	return context;
}
