import type { Doc } from "../_generated/dataModel";

function appendUnique(
	parts: string[],
	seen: Set<string>,
	value: string | undefined,
): void {
	const trimmed = value?.trim();
	if (!trimmed) {
		return;
	}

	const key = trimmed.toLowerCase();
	if (seen.has(key)) {
		return;
	}

	seen.add(key);
	parts.push(trimmed);
}

/**
 * Build a denormalized search string from lead fields and identifier values.
 */
export function buildLeadSearchText(
	lead: Pick<Doc<"leads">, "fullName" | "email" | "phone" | "socialHandles">,
	identifierValues?: string[],
): string | undefined {
	const parts: string[] = [];
	const seen = new Set<string>();

	appendUnique(parts, seen, lead.fullName);
	appendUnique(parts, seen, lead.email);
	appendUnique(parts, seen, lead.phone);

	for (const handle of lead.socialHandles ?? []) {
		appendUnique(parts, seen, handle.handle);
	}

	for (const value of identifierValues ?? []) {
		appendUnique(parts, seen, value);
	}

	return parts.length > 0 ? parts.join(" ") : undefined;
}
