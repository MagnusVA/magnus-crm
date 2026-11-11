import { fetchQuery } from "@/lib/convex-server-reads";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { PageBand } from "@/app/workspace/_components/page-band";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { requirePermission } from "@/lib/auth";
import { MEMBER_FILTER_ERROR } from "@/convex/reports/lib/access";
import { getErrorCode, isExpectedConvexRejection } from "@/lib/errors";
import ReportsLoading from "../../loading";
import { REPORT_PAGE } from "../../_components/report-ui";
import { MemberPageClient } from "./_components/member-page-client";

export const instant = false;

const ADMIN_ROLES = new Set(["tenant_master", "tenant_admin"]);

/** The range part of the query, kept when a closer is sent to their own report. */
function rangeSuffix(query: Record<string, string | string[] | undefined>) {
  const kept = new URLSearchParams();
  for (const key of ["range", "from", "to"]) {
    const value = query[key];
    if (typeof value === "string" && value) kept.set(key, value);
  }
  const text = kept.toString();
  return text ? `?${text}` : "";
}

// A member's report. Admins open anyone's; closers and lead generators open
// only their own, and Convex enforces the same rule on every reader. A
// non-admin who follows someone else's link lands on their own report.
export default async function MemberReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ memberId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { session, crmUser } = await requirePermission("reports:view-own");
  const { memberId } = await params;
  const isAdmin = ADMIN_ROLES.has(crmUser.role);
  const token = { token: session.accessToken };

  if (!isAdmin) {
    let ownId: Id<"teamMembers"> | null = null;
    try {
      ownId = (await fetchQuery(api.reports.member.getMemberProfile, {}, token))?.teamMemberId ?? null;
    } catch (error) {
      // The one refusal a non-admin gets here: their login has no team member
      // yet. Branch on the code: production redacts plain errors' messages.
      if (getErrorCode(error) !== MEMBER_FILTER_ERROR.notLinked) throw error;
    }
    if (!ownId) {
      return (
        <div className={REPORT_PAGE}>
          <PageBand
            title="Your report"
            description="Your account isn't linked to a team member yet, so there's no report to show. An admin can link it on Team."
          />
        </div>
      );
    }
    if (ownId !== memberId) redirect(`/workspace/reports/people/${ownId}${rangeSuffix(await searchParams)}`);
  } else {
    let found = false;
    try {
      found = (await fetchQuery(api.reports.member.getMemberProfile, { memberId: memberId as Id<"teamMembers"> }, token)) !== null;
    } catch (error) {
      // A member that isn't the tenant's (merged away, deleted, another
      // tenant's) or a malformed id is a 404; anything else reaches the error
      // boundary.
      const code = getErrorCode(error);
      const missing =
        code === MEMBER_FILTER_ERROR.invalidMember || (code === undefined && isExpectedConvexRejection(error));
      if (!missing) throw error;
    }
    if (!found) notFound();
  }

  return (
    <Suspense fallback={<ReportsLoading />}>
      <MemberPageClient memberId={memberId as Id<"teamMembers">} viewerRole={crmUser.role} />
    </Suspense>
  );
}
