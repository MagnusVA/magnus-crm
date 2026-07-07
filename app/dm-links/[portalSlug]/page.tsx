import { fetchAction } from "convex/nextjs";
import { cookies } from "next/headers";
import { api } from "@/convex/_generated/api";
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
				}).catch(() => null)
			: null;

	return (
		<DmLinkPortalClient
			portalSlug={portalSlug ?? rawPortalSlug}
			bootstrap={bootstrap}
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
