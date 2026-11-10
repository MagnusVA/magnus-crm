import type { QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { listTeamProgramEventTypesForTenant } from "../lib/attribution/teamEventTypeRoutes";
import {
  isCoverageMigrated,
  listSharedRoutes,
  teamUsesShared,
} from "../lib/bookingSetup/coverageData";
import {
  listProgramsForTenant,
  sortProgramsForDisplay,
} from "../tenantPrograms/shared";
export async function buildCoverage(ctx: QueryCtx, tenantId: Id<"tenants">) {
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
      usesShared: migrated
        ? teamUsesShared(team)
        : !routedTeamIds.has(team._id),
      bookingDailyQuota: team.bookingDailyQuota,
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
      hasSocialHandleField: Boolean(
        config.customFieldMappings?.socialHandleField,
      ),
      formQuestionCount: config.knownCustomFieldKeys?.length ?? 0,
      calendlyKind: config.calendlyKind,
    })),
  };
}
