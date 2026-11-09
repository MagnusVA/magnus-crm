import type { Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import type { CrmRole } from "../../lib/roleMapping";
import type { TenantUserResult } from "../../requireTenantUser";
import type { AnalyticsFilterValue } from "../../analytics/definition";
import { expectedError } from "../../lib/observability/errors";

// Who may read a member report (docs/reviews/reports-decisions.html, D10).
// Admins read anyone's, and the roster of everyone. Closers and lead
// generators read their own report only: the member filter is forced to their
// own team member, never taken from the client.

/** Roles that can open the rebuilt Reports' roster and every page. */
export const REPORT_ADMIN_ROLES = ["tenant_master", "tenant_admin"] as const satisfies readonly CrmRole[];

/** Roles that can open a member report: admins, and a member for themselves. */
export const MEMBER_REPORT_ROLES = [
  "tenant_master",
  "tenant_admin",
  "closer",
  "lead_generator",
] as const satisfies readonly CrmRole[];

export function isReportAdmin(role: CrmRole): boolean {
  return (REPORT_ADMIN_ROLES as readonly CrmRole[]).includes(role);
}

/** The viewer's own team member, or null when the user has none yet. */
export async function viewerTeamMemberId(
  ctx: QueryCtx,
  viewer: Pick<TenantUserResult, "userId" | "tenantId">,
): Promise<Id<"teamMembers"> | null> {
  const user = await ctx.db.get("users", viewer.userId);
  if (!user || user.tenantId !== viewer.tenantId) return null;
  return user.teamMemberId ?? null;
}

/**
 * The codes `resolveMemberFilter` refuses with. They're expected rejections,
 * so production shows their messages, and pages branch on the code.
 */
export const MEMBER_FILTER_ERROR = {
  /** A closer or lead generator whose login has no team member yet. */
  notLinked: "reports.member_not_linked",
  /** A closer or lead generator asking for someone else's report. */
  notOwn: "reports.not_own_report",
  /** A member id that isn't one of the tenant's (malformed, merged away, deleted, another tenant's). */
  invalidMember: "reports.invalid_member",
} as const;

/**
 * The member a people or member report is about. Admins may pass any team
 * member of their tenant, or none for the roster. Anyone else gets their own
 * team member whatever they pass, and can't read the roster.
 */
export async function resolveMemberFilter(
  ctx: QueryCtx,
  raw: AnalyticsFilterValue | undefined,
  viewer: Pick<TenantUserResult, "userId" | "tenantId" | "role">,
): Promise<Id<"teamMembers"> | null> {
  if (!isReportAdmin(viewer.role)) {
    const own = await viewerTeamMemberId(ctx, viewer);
    if (!own) throw expectedError(MEMBER_FILTER_ERROR.notLinked, "Your account isn't linked to a team member yet.");
    if (raw !== undefined && raw !== null && raw !== "" && raw !== own) {
      throw expectedError(MEMBER_FILTER_ERROR.notOwn, "You can only open your own report.");
    }
    return own;
  }
  if (raw === undefined || raw === null || raw === "") return null;
  const invalid = () => expectedError(MEMBER_FILTER_ERROR.invalidMember, "Invalid filter.");
  if (typeof raw !== "string") throw invalid();
  const memberId = ctx.db.normalizeId("teamMembers", raw);
  if (!memberId) throw invalid();
  const member = await ctx.db.get("teamMembers", memberId);
  if (!member || member.tenantId !== viewer.tenantId) throw invalid();
  return memberId;
}
