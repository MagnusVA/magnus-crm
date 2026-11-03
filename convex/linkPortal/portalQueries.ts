import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import {
	buildPortalEventTypeRouting,
	listTeamProgramEventTypesForTenant,
} from "../lib/attribution/teamEventTypeRoutes";
import { isPortalBookable } from "../lib/eventTypeBookability";
import { linkIssue, linkableEventTypeIdsForTeam } from "../lib/bookingSetup/coverage";
import {
	isCoverageMigrated,
	listSharedRoutes,
	teamUsesShared,
} from "../lib/bookingSetup/coverageData";
import { log } from "../lib/observability/log";
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
			log.warn("link_portal.session.rejected", {
				reason: !config
					? "portal_not_found"
					: !config.isEnabled
						? "portal_disabled"
						: config.publicSlug !== publicSlug
							? "slug_rotated"
							: "session_version_stale",
				tenantId,
				sessionVersion,
			});
			throw new Error("Portal session is no longer valid.");
		}

		const tenant = await ctx.db.get("tenants", tenantId);
		if (!tenant) {
			throw new Error("Portal session is no longer valid.");
		}

		const migrated = isCoverageMigrated(tenant);
		const [teams, closers, campaignPresets, eventTypeConfigs, teamRoutes, sharedRoutes, activePrograms] =
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
				listTeamProgramEventTypesForTenant(ctx, tenantId),
				migrated ? listSharedRoutes(ctx, tenantId) : Promise.resolve([]),
				migrated
					? ctx.db
							.query("tenantPrograms")
							.withIndex("by_tenantId_and_archivedAt", (q) =>
								q.eq("tenantId", tenantId).eq("archivedAt", undefined),
							)
							.take(200)
					: Promise.resolve([]),
			]);

		const activeTeamById = new Map(
			teams.filter((team) => team.isActive).map((team) => [team._id, team]),
		);
		// Event type id -> the active teams whose DM closers get it.
		const teamIdsByEventType = new Map<string, Array<(typeof teams)[number]["_id"]>>();
		const addTeam = (eventTypeConfigId: string, teamId: (typeof teams)[number]["_id"]) => {
			const list = teamIdsByEventType.get(eventTypeConfigId) ?? [];
			list.push(teamId);
			teamIdsByEventType.set(eventTypeConfigId, list);
		};
		let bookable: typeof eventTypeConfigs;
		if (migrated) {
			// Booking coverage: a cell publishes its event type.
			const eventTypesById = new Map(eventTypeConfigs.map((config) => [config._id as string, config]));
			for (const team of activeTeamById.values()) {
				const linkable = linkableEventTypeIdsForTeam({
					usesShared: teamUsesShared(team),
					teamRoutes: teamRoutes.filter((route) => route.teamId === team._id),
					sharedRoutes,
					eventTypesById,
				});
				for (const eventTypeConfigId of linkable) addTeam(eventTypeConfigId, team._id);
			}
			// Archived programs keep their cells, but their links can't be copied.
			const activeProgramIds = new Set<string>(activePrograms.map((program) => program._id));
			bookable = eventTypeConfigs.filter(
				(config) =>
					linkIssue(config) === null &&
					teamIdsByEventType.has(config._id) &&
					config.bookingProgramId !== undefined &&
					activeProgramIds.has(config.bookingProgramId),
			);
		} else {
			// Legacy rule: a team with routes sees only its routed event types;
			// a team without routes sees the ones no team is routed to.
			const routing = buildPortalEventTypeRouting(teamRoutes);
			bookable = eventTypeConfigs.filter((config) => isPortalBookable(config));
			for (const config of bookable) {
				const teamIds = routing.isShared(config._id)
					? [...activeTeamById.keys()].filter((teamId) => !routing.routedTeamIds.has(teamId))
					: routing.teamsForEventType(config);
				for (const teamId of teamIds) addTeam(config._id, teamId);
			}
		}

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
			bookablePrograms: bookable
				.filter((config) => config.bookingProgramId !== undefined)
				.map((config) => ({
					eventTypeConfigId: config._id,
					eventTypeDisplayName: config.displayName,
					bookingProgramId: config.bookingProgramId!,
					bookingProgramName: config.bookingProgramName ?? config.displayName,
					bookingBaseUrl: config.bookingBaseUrl!,
					isExtended: config.isExtended === true,
					// Active teams whose DM closers get this event type.
					teamIds: teamIdsByEventType.get(config._id) ?? [],
				})),
		};
	},
});
