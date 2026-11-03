import { v } from "convex/values";
import { internalQuery, query } from "../_generated/server";
import { listTeamProgramEventTypesForTenant } from "../lib/attribution/teamEventTypeRoutes";
import {
  isCoverageMigrated,
  listSharedRoutes,
  planCoverageMigration,
  teamUsesShared,
} from "../lib/bookingSetup/coverageData";
import { listProgramsForTenant, sortProgramsForDisplay } from "../tenantPrograms/shared";
import { requireTenantUser } from "../requireTenantUser";

// Everything the booking setup screens need in one subscription: programs,
// teams, both kinds of cells, and a slim row per event type. Bounded by the
// same caps as the portal (500 event types, 200 teams, 300 DM closers).
export const getCoverage = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const tenant = await ctx.db.get("tenants", tenantId);
    const migrated = tenant !== null && isCoverageMigrated(tenant);

    const [programs, teams, dmClosers, teamRoutes, sharedRoutes, eventTypes] =
      await Promise.all([
        listProgramsForTenant(ctx, tenantId),
        ctx.db
          .query("attributionTeams")
          .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
          .take(200),
        ctx.db
          .query("dmClosers")
          .withIndex("by_tenantId_and_teamId", (q) => q.eq("tenantId", tenantId))
          .take(300),
        listTeamProgramEventTypesForTenant(ctx, tenantId),
        listSharedRoutes(ctx, tenantId),
        ctx.db
          .query("eventTypeConfigs")
          .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
          .take(500),
      ]);

    const routedTeamIds = new Set(teamRoutes.map((route) => route.teamId));
    const activeDmClosersByTeam = new Map<string, number>();
    for (const closer of dmClosers) {
      if (!closer.isActive) continue;
      activeDmClosersByTeam.set(
        closer.teamId,
        (activeDmClosersByTeam.get(closer.teamId) ?? 0) + 1,
      );
    }

    return {
      migrated,
      programs: sortProgramsForDisplay(programs).map((program) => ({
        _id: program._id,
        name: program.name,
        description: program.description,
        defaultCurrency: program.defaultCurrency,
        archivedAt: program.archivedAt,
      })),
      teams: teams.map((team) => ({
        _id: team._id,
        displayName: team.displayName,
        utmSource: team.utmSource,
        isActive: team.isActive,
        // Before the migration, show what it will set.
        usesShared: migrated ? teamUsesShared(team) : !routedTeamIds.has(team._id),
        activeDmClosers: activeDmClosersByTeam.get(team._id) ?? 0,
      })),
      teamRoutes: teamRoutes.map((route) => ({
        _id: route._id,
        teamId: route.teamId,
        programId: route.programId,
        mode: route.mode,
        eventTypeConfigId: route.eventTypeConfigId,
      })),
      sharedRoutes: sharedRoutes.map((route) => ({
        _id: route._id,
        programId: route.programId,
        mode: route.mode,
        eventTypeConfigId: route.eventTypeConfigId,
      })),
      eventTypes: eventTypes.map((config) => ({
        _id: config._id,
        _creationTime: config._creationTime,
        displayName: config.displayName,
        calendlyName: config.calendlyName,
        calendlyColor: config.calendlyColor,
        calendlyDurationMinutes: config.calendlyDurationMinutes,
        calendlyPoolingType: config.calendlyPoolingType,
        calendlySyncStatus: config.calendlySyncStatus,
        calendlySchedulingUrl: config.calendlySchedulingUrl,
        lastCalendlySyncedAt: config.lastCalendlySyncedAt,
        bookingBaseUrl: config.bookingBaseUrl,
        bookingUrlSource: config.bookingUrlSource,
        bookingProgramId: config.bookingProgramId,
        bookingProgramMappingStatus: config.bookingProgramMappingStatus,
        isExtended: config.isExtended,
        notSalesCallAt: config.notSalesCallAt,
        linkPortalEnabled: config.linkPortalEnabled,
        paymentLinkCount: config.paymentLinks?.length ?? 0,
        hasSocialHandleField: Boolean(config.customFieldMappings?.socialHandleField),
      })),
    };
  },
});

// Dry run of the move to booking coverage for one tenant. Read only:
// npx convex run bookingSetup/queries:previewCoverageMigration '{"tenantId":"..."}'
export const previewCoverageMigration = internalQuery({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    return await planCoverageMigration(ctx, tenantId);
  },
});
