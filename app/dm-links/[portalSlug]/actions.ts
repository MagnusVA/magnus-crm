"use server";

import { createHmac } from "node:crypto";
import { fetchAction } from "convex/nextjs";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
	normalizePortalSlugParam,
	portalSessionCookieName,
	portalSessionCookiePath,
} from "./_lib/portal-session-cookie";

const GENERIC_PORTAL_AUTH_ERROR = "Portal unavailable or password invalid.";
const DEVELOPMENT_IP_HASH_SECRET =
	"development-only-link-portal-ip-hash-secret";

let warnedMissingIpHashSecret = false;

export type PortalUnlockState =
	| { status: "idle"; message?: undefined }
	| { status: "error"; message: string };

export type PortalCopyInput = {
	eventTypeConfigId: string;
	dmCloserId: string;
	campaignPresetId: string;
};

export type PortalCopyResult = {
	recorded: boolean;
};

// === NIM-17 Phase 5: portal lead surface ===

export type PortalLeadInitialSource = "cta" | "inbound" | "wechat";

export type PortalLeadRow = {
	leadId: string;
	displayName: string;
	socialHandles: Array<{ type: string; handle: string }>;
	status: "active" | "converted";
	initialSource: PortalLeadInitialSource | null;
	selfReportedIncome: number | null;
	noteCount: number;
	lastNoteAt: number | null;
};

export type PortalLeadNote = {
	noteId: string;
	content: string;
	createdAt: number;
	authorKind: "dm_closer" | "user";
	authorLabel: string;
};

export type PortalLeadSearchResult =
	| { status: "ok"; rows: PortalLeadRow[] }
	| { status: "logged_out" }
	| { status: "error"; message: string };

export type PortalLeadProfileInput = {
	dmCloserId: string;
	leadId: string;
	/** undefined leaves the field untouched; null clears it. */
	initialSource?: PortalLeadInitialSource | null;
	/** undefined leaves the field untouched; null clears it. */
	selfReportedIncome?: number | null;
};

export type PortalLeadProfileResult =
	| { status: "ok" }
	| { status: "logged_out" }
	| { status: "error"; message: string };

export type PortalLeadNoteInput = {
	dmCloserId: string;
	leadId: string;
	content: string;
};

export type PortalLeadNoteResult =
	| { status: "ok"; noteId: string }
	| { status: "logged_out" }
	| { status: "error"; message: string };

export type PortalLeadNotesResult =
	| { status: "ok"; notes: PortalLeadNote[] }
	| { status: "logged_out" }
	| { status: "error"; message: string };

function ipHashSecret() {
	const secret = process.env.LINK_PORTAL_IP_HASH_SECRET;
	if (secret) {
		return secret;
	}
	if (process.env.NODE_ENV !== "production") {
		if (!warnedMissingIpHashSecret) {
			console.warn(
				"[LinkPortal] LINK_PORTAL_IP_HASH_SECRET is not configured; using a development-only IP hash secret.",
			);
			warnedMissingIpHashSecret = true;
		}
		return DEVELOPMENT_IP_HASH_SECRET;
	}
	throw new Error("LINK_PORTAL_IP_HASH_SECRET is not configured.");
}

async function hashRequesterIp() {
	const headerStore = await headers();
	const forwardedFor = headerStore.get("x-forwarded-for")?.split(",")[0]?.trim();
	const realIp = headerStore.get("x-real-ip")?.trim();
	const ip = forwardedFor || realIp || "unknown";

	return createHmac("sha256", ipHashSecret()).update(ip).digest("base64url");
}

function portalCookieOptions(portalSlug: string, maxAge: number) {
	return {
		httpOnly: true,
		secure: process.env.NODE_ENV === "production",
		sameSite: "lax" as const,
		path: portalSessionCookiePath(portalSlug),
		maxAge,
		priority: "high" as const,
	};
}

export async function unlockPortal(
	rawPortalSlug: string,
	_prevState: PortalUnlockState,
	formData: FormData,
): Promise<PortalUnlockState> {
	const portalSlug = normalizePortalSlugParam(rawPortalSlug);
	if (!portalSlug) {
		return { status: "error", message: GENERIC_PORTAL_AUTH_ERROR };
	}

	const password = String(formData.get("password") ?? "");
	let result: { sessionToken: string; maxAgeSeconds: number };

	try {
		const ipHash = await hashRequesterIp();
		result = await fetchAction(api.linkPortal.passwordActions.verifyPassword, {
			portalSlug,
			password,
			ipHash,
		});
	} catch (error) {
		console.error("[LinkPortal] unlock failed", error);
		return { status: "error", message: GENERIC_PORTAL_AUTH_ERROR };
	}

	const cookieStore = await cookies();
	cookieStore.set(
		portalSessionCookieName(portalSlug),
		result.sessionToken,
		portalCookieOptions(portalSlug, result.maxAgeSeconds),
	);

	redirect(portalSessionCookiePath(portalSlug));
}

export async function logoutPortal(rawPortalSlug: string, _formData: FormData) {
	const portalSlug = normalizePortalSlugParam(rawPortalSlug);
	if (!portalSlug) {
		redirect("/");
	}

	const cookieStore = await cookies();
	cookieStore.set(
		portalSessionCookieName(portalSlug),
		"",
		portalCookieOptions(portalSlug, 0),
	);

	redirect(portalSessionCookiePath(portalSlug));
}

export async function recordPortalCopy(
	rawPortalSlug: string,
	input: PortalCopyInput,
): Promise<PortalCopyResult> {
	const portalSlug = normalizePortalSlugParam(rawPortalSlug);
	if (!portalSlug) {
		return { recorded: false };
	}

	const cookieStore = await cookies();
	const sessionToken = cookieStore.get(
		portalSessionCookieName(portalSlug),
	)?.value;
	if (!sessionToken) {
		return { recorded: false };
	}

	try {
		await fetchAction(api.linkPortal.copyActions.recordCopyEvent, {
			portalSlug,
			sessionToken,
			eventTypeConfigId: input.eventTypeConfigId as Id<"eventTypeConfigs">,
			dmCloserId: input.dmCloserId as Id<"dmClosers">,
			campaignPresetId:
				input.campaignPresetId as Id<"linkPortalCampaignPresets">,
		});
		return { recorded: true };
	} catch (error) {
		console.warn("[LinkPortal] copy audit failed", error);
		return { recorded: false };
	}
}

// Mirrors the recordPortalCopy session handling: normalize the slug, read the
// httpOnly session cookie, and treat a missing cookie as logged out.
async function readPortalSession(rawPortalSlug: string) {
	const portalSlug = normalizePortalSlugParam(rawPortalSlug);
	if (!portalSlug) {
		return null;
	}

	const cookieStore = await cookies();
	const sessionToken = cookieStore.get(
		portalSessionCookieName(portalSlug),
	)?.value;
	if (!sessionToken) {
		return null;
	}

	return { portalSlug, sessionToken };
}

export async function searchPortalLeads(
	rawPortalSlug: string,
	searchTerm: string,
): Promise<PortalLeadSearchResult> {
	const session = await readPortalSession(rawPortalSlug);
	if (!session) {
		return { status: "logged_out" };
	}

	try {
		const rows = await fetchAction(
			api.linkPortal.leadActions.searchPortalLeads,
			{
				portalSlug: session.portalSlug,
				sessionToken: session.sessionToken,
				searchTerm,
			},
		);
		return { status: "ok", rows };
	} catch (error) {
		console.warn("[LinkPortal] lead search failed", error);
		return {
			status: "error",
			message: "Lead search failed. Try again in a moment.",
		};
	}
}

export async function updatePortalLeadProfile(
	rawPortalSlug: string,
	input: PortalLeadProfileInput,
): Promise<PortalLeadProfileResult> {
	const session = await readPortalSession(rawPortalSlug);
	if (!session) {
		return { status: "logged_out" };
	}

	try {
		await fetchAction(api.linkPortal.leadActions.updatePortalLeadProfile, {
			portalSlug: session.portalSlug,
			sessionToken: session.sessionToken,
			dmCloserId: input.dmCloserId as Id<"dmClosers">,
			leadId: input.leadId as Id<"leads">,
			...(input.initialSource !== undefined
				? { initialSource: input.initialSource }
				: {}),
			...(input.selfReportedIncome !== undefined
				? { selfReportedIncome: input.selfReportedIncome }
				: {}),
		});
		return { status: "ok" };
	} catch (error) {
		console.warn("[LinkPortal] lead profile update failed", error);
		return {
			status: "error",
			message: "Could not save the lead details. Try again in a moment.",
		};
	}
}

export async function addPortalLeadNote(
	rawPortalSlug: string,
	input: PortalLeadNoteInput,
): Promise<PortalLeadNoteResult> {
	const session = await readPortalSession(rawPortalSlug);
	if (!session) {
		return { status: "logged_out" };
	}

	const content = input.content.trim();
	if (content.length === 0 || content.length > 2000) {
		return {
			status: "error",
			message: "Notes must be between 1 and 2000 characters.",
		};
	}

	try {
		const noteId = await fetchAction(
			api.linkPortal.leadActions.addPortalLeadNote,
			{
				portalSlug: session.portalSlug,
				sessionToken: session.sessionToken,
				dmCloserId: input.dmCloserId as Id<"dmClosers">,
				leadId: input.leadId as Id<"leads">,
				content,
			},
		);
		return { status: "ok", noteId };
	} catch (error) {
		console.warn("[LinkPortal] add lead note failed", error);
		// The backend rate limit throws "Too many notes in a short time…"; the
		// message may be redacted in production, so keep the fallback friendly
		// for that case too.
		const isRateLimited =
			error instanceof Error && error.message.includes("Too many notes");
		return {
			status: "error",
			message: isRateLimited
				? "You're adding notes too quickly. Wait a minute and try again."
				: "Could not add the note. If you added several notes quickly, wait a minute and try again.",
		};
	}
}

export async function listPortalLeadNotes(
	rawPortalSlug: string,
	leadId: string,
): Promise<PortalLeadNotesResult> {
	const session = await readPortalSession(rawPortalSlug);
	if (!session) {
		return { status: "logged_out" };
	}

	try {
		const notes = await fetchAction(
			api.linkPortal.leadActions.listPortalLeadNotes,
			{
				portalSlug: session.portalSlug,
				sessionToken: session.sessionToken,
				leadId: leadId as Id<"leads">,
			},
		);
		return { status: "ok", notes };
	} catch (error) {
		console.warn("[LinkPortal] list lead notes failed", error);
		return {
			status: "error",
			message: "Could not load notes. Try again in a moment.",
		};
	}
}
