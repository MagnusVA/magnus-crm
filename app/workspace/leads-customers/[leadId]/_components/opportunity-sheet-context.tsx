"use client";

import {
	createContext,
	use,
	useCallback,
	useMemo,
	useState,
	type ReactNode,
} from "react";
import { useSearchParams } from "next/navigation";
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
	const searchParams = useSearchParams();
	// A `?opportunityId=` link opens the sheet on arrival.
	const [opportunityId, setOpportunityId] = useState<Id<"opportunities"> | null>(
		() =>
			(searchParams.get("opportunityId") as Id<"opportunities"> | null) ||
			null,
	);

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
