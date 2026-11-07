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
import type { Id } from "../_generated/dataModel";
import { normalizeUtmValue } from "../lib/attribution/normalize";
import {
  createLiveReadState,
  readLiveDocuments,
  readLiveQueryRows,
} from "../lib/liveQueryBounds";

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
        hasSocialHandleField: Boolean(config.customFieldMappings?.socialHandleField),
        formQuestionCount: config.knownCustomFieldKeys?.length ?? 0,
        calendlyKind: config.calendlyKind,
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

const DAY_MS = 24 * 60 * 60 * 1000;
// Bookings in the last 30 days are bounded by rows and bytes; the screens say
// "partial" when `capped` is set.
const ACTIVITY_MAX_MEETINGS = 4000;
const ACTIVITY_BYTE_BUDGET = 3 * 1024 * 1024;
const MAX_COPIES = 2000;

// Booking activity for the booking setup screens: bookings made in the last
// 30 days per event type, DM team and DM closer (matched by utm_source and
// utm_medium, as attribution does), and link copies in the last 7 days per
// team. Counts bookings when they were made (meetings.createdAt).
export const getBookingActivity = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const now = Date.now();
    const state = createLiveReadState();

    const [meetings, teams, dmClosers, copies] = await Promise.all([
      readLiveQueryRows(
        ctx.db
          .query("meetings")
          .withIndex("by_tenantId_and_createdAt", (q) =>
            q.eq("tenantId", tenantId).gte("createdAt", now - 30 * DAY_MS),
          )
          // Newest first, so a capped read keeps the most recent bookings.
          .order("desc"),
        ACTIVITY_MAX_MEETINGS,
        state,
        ACTIVITY_BYTE_BUDGET,
      ),
      ctx.db
        .query("attributionTeams")
        .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
        .take(200),
      ctx.db
        .query("dmClosers")
        .withIndex("by_tenantId_and_teamId", (q) => q.eq("tenantId", tenantId))
        .take(300),
      ctx.db
        .query("linkPortalCopyEvents")
        .withIndex("by_tenantId_and_copiedAt", (q) =>
          q.eq("tenantId", tenantId).gte("copiedAt", now - 7 * DAY_MS),
        )
        .order("desc")
        .take(MAX_COPIES + 1),
    ]);
    const copiesCapped = copies.length > MAX_COPIES;
    const recentCopies = copiesCapped ? copies.slice(0, MAX_COPIES) : copies;

    const opportunityIds = [...new Set(meetings.rows.map((meeting) => meeting.opportunityId))];
    // Its own budget: a capped meeting read must still resolve the event
    // types of the meetings it did read.
    const opportunities = await readLiveDocuments(
      opportunityIds,
      (opportunityId) => ctx.db.get("opportunities", opportunityId),
      createLiveReadState(),
      ACTIVITY_BYTE_BUDGET,
    );
    const eventTypeByOpportunity = new Map(
      opportunities.rows.map((opportunity) => [opportunity._id, opportunity.eventTypeConfigId]),
    );

    const teamBySource = new Map<string, Id<"attributionTeams">>();
    for (const team of teams) {
      if (team.isActive) teamBySource.set(team.normalizedUtmSource, team._id);
    }
    const closersByMedium = new Map<string, Array<(typeof dmClosers)[number]>>();
    for (const closer of dmClosers) {
      if (!closer.isActive) continue;
      const list = closersByMedium.get(closer.normalizedUtmMedium) ?? [];
      list.push(closer);
      closersByMedium.set(closer.normalizedUtmMedium, list);
    }

    const eventTypes: Record<string, number> = {};
    const teamsCount: Record<string, number> = {};
    const closersCount: Record<string, number> = {};
    for (const meeting of meetings.rows) {
      const eventTypeConfigId = eventTypeByOpportunity.get(meeting.opportunityId);
      if (eventTypeConfigId) eventTypes[eventTypeConfigId] = (eventTypes[eventTypeConfigId] ?? 0) + 1;
      const source = normalizeUtmValue(meeting.utmParams?.utm_source);
      const medium = normalizeUtmValue(meeting.utmParams?.utm_medium);
      const teamId = source ? teamBySource.get(source) : undefined;
      if (teamId) teamsCount[teamId] = (teamsCount[teamId] ?? 0) + 1;
      const candidates = medium ? (closersByMedium.get(medium) ?? []) : [];
      const closer = teamId
        ? candidates.find((candidate) => candidate.teamId === teamId)
        : candidates.length === 1
          ? candidates[0]
          : undefined;
      if (closer) closersCount[closer._id] = (closersCount[closer._id] ?? 0) + 1;
    }

    // UTM values on bookings that matched no team or DM closer, grouped.
    const unmatched = new Map<
      string,
      { utmSource: string | null; utmMedium: string | null; bookings: number; lastBookedAt: number }
    >();
    for (const meeting of meetings.rows) {
      if (meeting.attributionResolution !== "unmapped") continue;
      const utmSource = meeting.utmParams?.utm_source?.trim() || null;
      const utmMedium = meeting.utmParams?.utm_medium?.trim() || null;
      const key = `${utmSource ?? ""}\u0000${utmMedium ?? ""}`;
      const entry = unmatched.get(key) ?? { utmSource, utmMedium, bookings: 0, lastBookedAt: 0 };
      entry.bookings += 1;
      entry.lastBookedAt = Math.max(entry.lastBookedAt, meeting.createdAt);
      unmatched.set(key, entry);
    }

    const copies7d: Record<string, number> = {};
    for (const copy of recentCopies) {
      copies7d[copy.attributionTeamId] = (copies7d[copy.attributionTeamId] ?? 0) + 1;
    }

    return {
      bookings30d: {
        eventTypes,
        teams: teamsCount,
        dmClosers: closersCount,
        total: meetings.rows.length,
      },
      copies7d: { teams: copies7d, total: recentCopies.length },
      unmatchedUtms: [...unmatched.values()]
        .sort((left, right) => right.bookings - left.bookings || right.lastBookedAt - left.lastBookedAt)
        .slice(0, 50),
      capped: meetings.capped || opportunities.capped || copiesCapped,
    };
  },
});
