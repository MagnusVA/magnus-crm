import { fetchAction } from "convex/nextjs";
import { cookies } from "next/headers";
import { api } from "@/convex/_generated/api";
import { reportServerError } from "@/lib/observability/report-server-error";
import { DmLinkPortalClient } from "./_components/dm-link-portal-client";
import {
	addPortalLeadNote,
	listPortalLeadNotes,
	logoutPortal,
	recordPortalCopy,
	searchPortalLeads,
	unlockPortal,
	updatePortalLeadProfile,
} from "./actions";
import {
	normalizePortalSlugParam,
	portalSessionCookieName,
} from "./_lib/portal-session-cookie";
import { readSessionTokenTimes } from "./_lib/session-token-times";

export const unstable_instant = false;

type Props = {
	params: Promise<{ portalSlug: string }>;
};

export default async function DmLinksPage({ params }: Props) {
	const { portalSlug: rawPortalSlug } = await params;
	const portalSlug = normalizePortalSlugParam(rawPortalSlug);

	const sessionToken = portalSlug
		? (await cookies()).get(portalSessionCookieName(portalSlug))?.value
		: undefined;

	const bootstrap =
		portalSlug && sessionToken
			? await fetchAction(api.linkPortal.portalActions.getPortalBootstrap, {
					portalSlug,
					sessionToken,
				}).catch(async (error: unknown) => {
					// An expired session or unknown portal comes back from Convex
					// (already reported there); anything else is a page failure.
					await reportServerError(error, {
						event: "link_portal.bootstrap.failed",
						fingerprint: "link-portal:bootstrap",
						action: "bootstrap",
					});
					return null;
				})
			: null;

	// Display only: when the session ends and how long sessions last. A
	// cookie whose bootstrap failed means the session ended (it expired, the
	// password or path rotated, or the portal was turned off).
	const times = sessionToken ? readSessionTokenTimes(sessionToken) : null;
	const session = {
		expiresAt: bootstrap ? (times?.expiresAt ?? null) : null,
		ttlSeconds: times?.ttlSeconds ?? null,
		ended: Boolean(sessionToken) && !bootstrap,
	};

	return (
		<DmLinkPortalClient
			portalSlug={portalSlug ?? rawPortalSlug}
			bootstrap={bootstrap}
			session={session}
			unlockPortal={unlockPortal}
			logoutPortal={logoutPortal}
			recordPortalCopy={recordPortalCopy}
			searchPortalLeads={searchPortalLeads}
			updatePortalLeadProfile={updatePortalLeadProfile}
			addPortalLeadNote={addPortalLeadNote}
			listPortalLeadNotes={listPortalLeadNotes}
		/>
	);
}
