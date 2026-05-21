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
