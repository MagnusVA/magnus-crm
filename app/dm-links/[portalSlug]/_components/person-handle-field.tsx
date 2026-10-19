"use client";

import { useEffect } from "react";
import type { PortalPersonLookupResult } from "../actions";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

const LOOKUP_DELAY_MS = 400;

export type PersonLookupState =
	| { status: "empty" }
	| { status: "checking" }
	| PortalPersonLookupResult;

/** Whether a link can be copied for the looked-up person. */
export function canCopyForPerson(state: PersonLookupState): boolean {
	return state.status === "found" || state.status === "new";
}

/**
 * The Instagram handle of the person a link is for
 * (docs/plans/phase-2-person-first.md §4.3). The portal shows who it found,
 * or that copying creates a new person.
 */
export function PersonHandleField({
	portalSlug,
	value,
	onChange,
	lookup,
	onLookup,
	lookupPortalPerson,
}: {
	portalSlug: string;
	value: string;
	onChange: (value: string) => void;
	lookup: PersonLookupState;
	onLookup: (state: PersonLookupState) => void;
	lookupPortalPerson: (
		portalSlug: string,
		instagramHandle: string,
	) => Promise<PortalPersonLookupResult>;
}) {
	useEffect(() => {
		const handle = value.trim();
		if (!handle) {
			return;
		}
		let cancelled = false;
		const timeoutId = window.setTimeout(async () => {
			onLookup({ status: "checking" });
			let result: PersonLookupState;
			try {
				result = await lookupPortalPerson(portalSlug, handle);
			} catch {
				result = { status: "error", message: "Could not look up the handle. Try again." };
			}
			if (!cancelled) {
				onLookup(result);
			}
		}, LOOKUP_DELAY_MS);
		return () => {
			cancelled = true;
			window.clearTimeout(timeoutId);
		};
	}, [value, portalSlug, lookupPortalPerson, onLookup]);

	return (
		<Field>
			<FieldLabel htmlFor="dm-link-person-handle">
				Instagram handle of the person
			</FieldLabel>
			<Input
				id="dm-link-person-handle"
				value={value}
				onChange={(event) => {
					onChange(event.target.value);
					onLookup({ status: "empty" });
				}}
				placeholder="@handle"
				autoComplete="off"
				spellCheck={false}
				translate="no"
			/>
			<FieldDescription aria-live="polite">
				{describeLookup(lookup)}
			</FieldDescription>
		</Field>
	);
}

function describeLookup(lookup: PersonLookupState): string {
	switch (lookup.status) {
		case "empty":
			return "The link is made for this person, and their booking joins them.";
		case "checking":
			return "Checking…";
		case "invalid":
			return "That isn't an Instagram handle.";
		case "new":
			return `No one in the CRM has @${lookup.handle}. Copying a link adds them.`;
		case "conflict":
			return `More than one person has @${lookup.handle}. Ask an admin to merge them first.`;
		case "found":
			return `${lookup.displayName}, ${lookup.stageLabel}.`;
		case "logged_out":
			return "Your portal session ended. Unlock the portal again.";
		case "error":
			return lookup.message;
	}
}
