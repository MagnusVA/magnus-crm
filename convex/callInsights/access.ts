import type { Doc } from "../_generated/dataModel";
import type { QueryCtx, MutationCtx } from "../_generated/server";
import type { TenantUserResult } from "../requireTenantUser";
import { isOtherProspectsCall } from "../secondOpinion/trigger";
import { effectiveSettings } from "./settings";

export const VIEWER_ROLES = [
  "tenant_master",
  "tenant_admin",
  "closer",
  "lead_generator",
] as const;

/** Auth stays in the public handler; unsupported roles get an empty card. */
export async function insightsViewer(
  ctx: QueryCtx | MutationCtx,
  actor: TenantUserResult,
) {
  if (actor.role === "lead_generator") return null;
  const [tenant, user] = await Promise.all([
    ctx.db.get("tenants", actor.tenantId),
    ctx.db.get("users", actor.userId),
  ]);
  if (!tenant || !user || user.tenantId !== tenant._id) return null;
  return {
    tenant,
    user,
    isAdmin: actor.role === "tenant_master" || actor.role === "tenant_admin",
    settings: effectiveSettings(tenant),
  };
}
export type InsightsViewer = NonNullable<
  Awaited<ReturnType<typeof insightsViewer>>
>;

/** The deal's current assignment controls access, including older meetings. */
export async function canSeeMeeting(
  ctx: QueryCtx | MutationCtx,
  viewer: InsightsViewer,
  meeting: Doc<"meetings">,
): Promise<boolean> {
  if (meeting.tenantId !== viewer.tenant._id) return false;
  const deal = await ctx.db.get("opportunities", meeting.opportunityId);
  return (
    !!deal &&
    deal.tenantId === viewer.tenant._id &&
    (viewer.isAdmin || deal.assignedCloserId === viewer.user._id)
  );
}

export type CallHeader = Extract<Doc<"callInsightFacts">, { kind: "call" }>;
export type ItemFact = Exclude<Doc<"callInsightFacts">, { kind: "call" }>;

/** Recheck matching and person identity so stale publications never leak words. */
export async function visibleHeader(
  ctx: QueryCtx | MutationCtx,
  viewer: InsightsViewer,
  meeting: Doc<"meetings">,
  header: CallHeader,
): Promise<boolean> {
  if (
    header.tenantId !== viewer.tenant._id ||
    header.meetingId !== meeting._id ||
    !header.active
  )
    return false;
  const recording = await ctx.db.get("callRecordings", header.recordingId);
  return (
    !!recording &&
    recording.tenantId === viewer.tenant._id &&
    recording.matchStatus === "matched" &&
    recording.meetingId === meeting._id &&
    !(await isOtherProspectsCall(ctx, meeting, recording))
  );
}

export function atTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}
