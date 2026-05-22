"use node";

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { action } from "../_generated/server";
import { verifyPortalSessionToken } from "./sessionToken";

type PortalBootstrap = {
	tenantName: string;
	campaignPresets: Array<{
		id: string;
		label: string;
		utmCampaign: string;
		isDefault: boolean;
	}>;
	dmClosers: Array<{
		id: string;
		displayName: string;
		utmMedium: string;
		teamId: string;
		teamDisplayName: string;
		teamUtmSource: string;
	}>;
	bookablePrograms: Array<{
		eventTypeConfigId: string;
		eventTypeDisplayName: string;
		bookingProgramId: string;
		bookingProgramName: string;
		bookingBaseUrl: string;
		isExtended: boolean;
	}>;
};

export const getPortalBootstrap = action({
	args: {
		portalSlug: v.string(),
		sessionToken: v.string(),
	},
	handler: async (ctx, { portalSlug, sessionToken }): Promise<PortalBootstrap> => {
		const session = verifyPortalSessionToken(sessionToken);
		if (session.publicSlug !== portalSlug) {
			throw new Error("Portal session is no longer valid.");
		}

		const bootstrap: PortalBootstrap = await ctx.runQuery(
			internal.linkPortal.portalQueries.getPortalBootstrapForSession,
			{
				tenantId: session.tenantId,
				publicSlug: portalSlug,
				sessionVersion: session.sessionVersion,
			},
		);
		return bootstrap;
	},
});
