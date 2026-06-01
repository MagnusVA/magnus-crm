import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { isPortalBookable } from "../lib/eventTypeBookability";
import { publicDmCloserIdentity } from "../lib/memberIdentity";

export const getPortalBootstrapForSession = internalQuery({
	args: {
		tenantId: v.id("tenants"),
		publicSlug: v.string(),
		sessionVersion: v.number(),
	},
	handler: async (ctx, { tenantId, publicSlug, sessionVersion }) => {
		const config = await ctx.db
			.query("linkPortalConfigs")
			.withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
			.unique();
		if (
			!config ||
			!config.isEnabled ||
			config.publicSlug !== publicSlug ||
			config.sessionVersion !== sessionVersion
		) {
			throw new Error("Portal session is no longer valid.");
		}

		const tenant = await ctx.db.get(tenantId);
		if (!tenant) {
			throw new Error("Portal session is no longer valid.");
		}

		const [teams, closers, campaignPresets, eventTypeConfigs] =
			await Promise.all([
				ctx.db
					.query("attributionTeams")
					.withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
					.take(200),
				ctx.db
					.query("dmClosers")
					.withIndex("by_tenantId_and_teamId", (q) => q.eq("tenantId", tenantId))
					.take(300),
				ctx.db
					.query("linkPortalCampaignPresets")
					.withIndex("by_tenantId_and_isActive", (q) =>
						q.eq("tenantId", tenantId).eq("isActive", true),
					)
					.take(100),
				ctx.db
					.query("eventTypeConfigs")
					.withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
					.take(500),
			]);

		const activeTeamById = new Map(
			teams.filter((team) => team.isActive).map((team) => [team._id, team]),
		);

		return {
			tenantName: tenant.companyName,
			campaignPresets: campaignPresets
				.sort((left, right) => left.sortOrder - right.sortOrder)
				.map((campaign) => ({
					id: campaign._id,
					label: campaign.label,
					utmCampaign: campaign.utmCampaign,
					isDefault: campaign.isDefault,
				})),
			dmClosers: closers
				.filter((closer) => closer.isActive && activeTeamById.has(closer.teamId))
				.map((closer) => {
					const team = activeTeamById.get(closer.teamId);
					if (!team) {
						throw new Error("Portal bootstrap failed.");
					}

					return {
						id: closer._id,
						displayName: closer.displayName,
						identity: publicDmCloserIdentity(closer),
						utmMedium: closer.utmMedium,
						teamId: team._id,
						teamDisplayName: team.displayName,
						teamUtmSource: team.utmSource,
					};
				}),
			bookablePrograms: eventTypeConfigs
				.filter((config) => isPortalBookable(config))
				.map((config) => ({
					eventTypeConfigId: config._id,
					eventTypeDisplayName: config.displayName,
					bookingProgramId: config.bookingProgramId!,
					bookingProgramName: config.bookingProgramName ?? config.displayName,
					bookingBaseUrl: config.bookingBaseUrl!,
					isExtended: config.isExtended === true,
				})),
		};
	},
});
