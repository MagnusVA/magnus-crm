import type { QueryCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import type { AnalyticsFilters } from "../../analytics/definition";
import type { ResolvedAnalyticsRange } from "../../../lib/analyticsRange";
import { readFunnel, readCash, readFollowThrough, readOrigins, readAnswers } from "../../reports/scorecard";
import { readCallsSummary } from "../../reports/calls";
import { readPeopleClosers } from "../../reports/people";
import { readPeopleRole } from "../../reports/peopleRoles";
import { readMemberProfile, readReportMembers } from "../../reports/member";
import { readLanes, readPaths } from "../../reports/attribution";
import { readPipelineNow } from "../../reports/pipeline";
import { readOperationsPanel } from "./operations";
import { readLeadGenPanel } from "./leadGen";
/** The caller authorizes first. These are the exact load/build paths used by
 * the page queries, whose public auth and member guards stay in place.
 */
export async function readLivePanel(ctx: QueryCtx, tenantId: Id<"tenants">, id: string, filters: AnalyticsFilters, range: ResolvedAnalyticsRange): Promise<unknown> {
    if (id.startsWith("lead_gen.")) return readLeadGenPanel(ctx, tenantId, id, filters, range);
    if (id === "qualifications.dashboard") return readOperationsPanel(ctx, tenantId, id, range);
    const dates = { startDate: range.fromMs, endDate: range.toMs };
    const program = filters.programId ? { programId: filters.programId as Id<"tenantPrograms"> } : {};
    const memberId = filters.memberId as Id<"teamMembers"> | null;
    switch (id) {
        case "scorecard.funnel": return readFunnel(ctx, tenantId, { range, ...program });
        case "scorecard.cash": return readCash(ctx, tenantId, { range, ...program });
        case "scorecard.follow_through": return readFollowThrough(ctx, tenantId, { range, ...program });
        case "scorecard.origins": return readOrigins(ctx, tenantId, { range, ...program });
        case "scorecard.answers": return readAnswers(ctx, tenantId, { range, ...program, fieldKey: String(filters.fieldKey) });
        case "calls.summary": return readCallsSummary(ctx, tenantId, { ...dates, ...program, ...(filters.closerId ? { closerId: filters.closerId as Id<"users"> } : {}), ...(filters.callType ? { callType: filters.callType as "new" | "follow_up" } : {}) });
        case "people.members": return readReportMembers(ctx, tenantId);
        case "people.profile": return readMemberProfile(ctx, tenantId, memberId!);
        case "people.closers": return readPeopleClosers(ctx, tenantId, dates, memberId);
        case "people.setters": return readPeopleRole(ctx, tenantId, dates, "setter", memberId);
        case "people.dm_closers": return readPeopleRole(ctx, tenantId, dates, "dm_closer", memberId);
        case "people.lead_gen": return readPeopleRole(ctx, tenantId, dates, "lead_gen", memberId);
        case "attribution.lanes": return readLanes(ctx, tenantId, dates);
        case "attribution.paths": return readPaths(ctx, tenantId, dates);
        case "pipeline.now": return readPipelineNow(ctx, tenantId, {});
        default: throw new Error("Unsupported report panel.");
    }
}
