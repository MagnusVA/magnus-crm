"use client";

import { useEffect } from "react";
import posthog from "@/lib/posthog-browser";
import { isPostHogEnabled } from "@/lib/posthog-config";
import {
	useHydrated,
	useRememberedCloser,
	useRememberedSessionSeconds,
	useRememberedTenantName,
} from "./device-memory";
import { PortalLinkSheet } from "./portal-link-sheet";
import { PortalPasswordScreen } from "./portal-password-screen";
import type {
	PortalActions,
	PortalBootstrap,
	PortalSessionInfo,
} from "./portal-types";
import { PortalWhoScreen } from "./portal-who-screen";

type DmLinkPortalClientProps = PortalActions & {
	portalSlug: string;
	bootstrap: PortalBootstrap | null;
	session: PortalSessionInfo;
};

/**
 * The public DM link portal, concept C's flow: (1) password, once per
 * session; (2) "Who are you?", once per device; (3) one sheet of links.
 * Every server check stays where it was: the unlock and copy logging are
 * server actions that verify the httpOnly session token in Convex.
 */
export function DmLinkPortalClient({
	portalSlug,
	bootstrap,
	session,
	...actions
}: DmLinkPortalClientProps) {
	if (!bootstrap) {
		return (
			<PortalPasswordScreen
				portalSlug={portalSlug}
				session={session}
				unlockPortal={actions.unlockPortal}
			/>
		);
	}

	return (
		<UnlockedPortal
			portalSlug={portalSlug}
			bootstrap={bootstrap}
			session={session}
			actions={actions}
		/>
	);
}

function UnlockedPortal({
	portalSlug,
	bootstrap,
	session,
	actions,
}: {
	portalSlug: string;
	bootstrap: PortalBootstrap;
	session: PortalSessionInfo;
	actions: PortalActions;
}) {
	const hydrated = useHydrated();
	const [closerId, setCloserId] = useRememberedCloser(portalSlug);
	const [, setSessionSeconds] = useRememberedSessionSeconds(portalSlug);
	const [, setTenantName] = useRememberedTenantName(portalSlug);
	// A remembered closer who was removed or disabled falls back to "Who are you?".
	const closer = bootstrap.dmClosers.find((row) => row.id === closerId) ?? null;

	// Remember what the password screen shows next time.
	useEffect(() => {
		if (session.ttlSeconds) setSessionSeconds(String(session.ttlSeconds));
		setTenantName(bootstrap.tenantName);
	}, [session.ttlSeconds, bootstrap.tenantName, setSessionSeconds, setTenantName]);

	const signOut = actions.logoutPortal.bind(null, portalSlug);

	if (!hydrated) {
		// localStorage isn't readable on the server; render nothing for one frame
		// rather than flashing "Who are you?" at a closer we already know.
		return <main className="min-h-dvh bg-background" aria-busy="true" />;
	}

	if (!closer) {
		return (
			<PortalWhoScreen
				tenantName={bootstrap.tenantName}
				closers={bootstrap.dmClosers}
				signOut={signOut}
				onPick={(picked) => {
					setCloserId(picked.id);
					if (isPostHogEnabled()) {
						posthog.capture("dm_link_portal_closer_picked", {
							dm_closer_id: picked.id,
							team_id: picked.teamId,
						});
					}
				}}
			/>
		);
	}

	return (
		<PortalLinkSheet
			key={closer.id}
			portalSlug={portalSlug}
			bootstrap={bootstrap}
			closer={closer}
			sessionExpiresAt={session.expiresAt}
			actions={actions}
			onNotYou={() => setCloserId(null)}
		/>
	);
}
