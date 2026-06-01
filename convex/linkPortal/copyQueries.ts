import { v } from "convex/values";
import { query } from "../_generated/server";
import { dmCloserMemberIdentity } from "../lib/memberIdentity";
import { requireTenantUser } from "../requireTenantUser";

const DEFAULT_RECENT_COPY_LIMIT = 25;
const MAX_RECENT_COPY_LIMIT = 100;

function clampLimit(limit: number | undefined) {
  if (limit === undefined) {
    return DEFAULT_RECENT_COPY_LIMIT;
  }
  const normalized = Math.floor(limit);
  if (!Number.isFinite(normalized) || normalized < 1) {
    return DEFAULT_RECENT_COPY_LIMIT;
  }
  return Math.min(normalized, MAX_RECENT_COPY_LIMIT);
}

export const listRecentCopyEvents = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const rows = await ctx.db
      .query("linkPortalCopyEvents")
      .withIndex("by_tenantId_and_copiedAt", (q) => q.eq("tenantId", tenantId))
      .order("desc")
      .take(clampLimit(limit));

    return await Promise.all(
      rows.map(async (row) => {
        const [eventTypeConfig, bookingProgram, team, dmCloser, campaign] =
          await Promise.all([
            ctx.db.get(row.eventTypeConfigId),
            ctx.db.get(row.bookingProgramId),
            ctx.db.get(row.attributionTeamId),
            ctx.db.get(row.dmCloserId),
            ctx.db.get(row.campaignPresetId),
          ]);
        const linkedDmCloserUser =
          dmCloser?.tenantId === tenantId && dmCloser.userId
            ? await ctx.db.get(dmCloser.userId)
            : null;
        const validLinkedDmCloserUser =
          linkedDmCloserUser?.tenantId === tenantId ? linkedDmCloserUser : null;

        return {
          id: row._id,
          copiedAt: row.copiedAt,
          eventTypeConfigId: row.eventTypeConfigId,
          bookingProgramId: row.bookingProgramId,
          attributionTeamId: row.attributionTeamId,
          dmCloserId: row.dmCloserId,
          campaignPresetId: row.campaignPresetId,
          utmCampaign: row.utmCampaign,
          eventTypeName:
            eventTypeConfig?.tenantId === tenantId
              ? eventTypeConfig.displayName
              : "Unknown event type",
          bookingProgramName:
            bookingProgram?.tenantId === tenantId
              ? bookingProgram.name
              : "Unknown program",
          attributionTeamName:
            team?.tenantId === tenantId ? team.displayName : "Unknown team",
          dmCloserName:
            dmCloser?.tenantId === tenantId
              ? dmCloser.displayName
              : "Unknown DM closer",
          dmCloser:
            dmCloser?.tenantId === tenantId
              ? await dmCloserMemberIdentity(ctx, dmCloser, validLinkedDmCloserUser)
              : null,
          campaignLabel:
            campaign?.tenantId === tenantId ? campaign.label : row.utmCampaign,
        };
      }),
    );
  },
});
