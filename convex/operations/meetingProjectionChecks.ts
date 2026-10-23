import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { getTenantBusinessDay } from "../lib/tenantBusinessDay";
import { bucketKey, meetingDayKey } from "./meetingStats";

export async function assertMeetingProjection(ctx: QueryCtx, meeting: Doc<"meetings">) {
  const projection = await ctx.db.query("meetingProjections").withIndex("by_meetingId", q => q.eq("meetingId", meeting._id)).unique();
  const opportunity = await ctx.db.get("opportunities", meeting.opportunityId);
  if (!opportunity || opportunity.tenantId !== meeting.tenantId) throw new Error(`${meeting._id}`);
  const key = bucketKey({ dayKey: meetingDayKey(meeting.scheduledAt, await getTenantBusinessDay(ctx, meeting.tenantId)), assignedCloserId: meeting.assignedCloserId, bookingProgramId: meeting.bookingProgramId, soldProgramId: opportunity.soldProgramId, meetingStatus: meeting.status });
  const bucket = await ctx.db.query("operationsMeetingStatsV2").withIndex("by_tenantId_and_bucketKey", q => q.eq("tenantId", meeting.tenantId).eq("bucketKey", key)).unique();
  if (!bucket || projection?.tenantId !== meeting.tenantId || projection.status !== "applied" || projection.bucketKey !== key) throw new Error(`${meeting._id}`);
}
export async function assertMeetingProjectionBucket(ctx: QueryCtx, bucket: Doc<"operationsMeetingStatsV2">) {
  if (!Number.isInteger(bucket.count) || bucket.count <= 0 || bucket.count > 8192) throw new Error(`${bucket._id}`);
  const contributions = await ctx.db.query("meetingProjections").withIndex("by_tenantId_and_bucketKey", q => q.eq("tenantId", bucket.tenantId).eq("bucketKey", bucket.bucketKey)).take(bucket.count + 1);
  if (contributions.length > 8192 || bucket.count <= 0 || bucket.count !== contributions.length) throw new Error(`${bucket._id}`);
}
export async function assertMeetingProjectionSource(ctx: QueryCtx, projection: Doc<"meetingProjections">) {
  const meeting = await ctx.db.get("meetings", projection.meetingId);
  if (projection.status !== "applied" || (meeting && meeting.tenantId !== projection.tenantId) || (!meeting && (projection.contribution || projection.bucketKey)) || (projection.contribution && projection.bucketKey !== bucketKey(projection.contribution))) throw new Error(`${projection._id}`);
}
