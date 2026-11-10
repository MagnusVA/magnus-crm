import { mergeFunnel, mergeCash, mergeFollowThrough, mergeOrigins } from "../../analytics/merge/scorecard";
import { mergeCallsSummary } from "../../analytics/merge/calls";
import { mergePeopleClosers } from "../../analytics/merge/people";
import { mergePeopleRoles } from "../../analytics/merge/peopleRoles";
import { mergeAttributionLanes, mergeAttributionPaths } from "../../analytics/merge/attribution";
import { mergeQualificationsDashboard } from "../../analytics/merge/operations";
import { mergeLeadGenOverview, mergeLeadGenWorkers, mergeLeadGenTopOriginsByTeam, mergeLeadGenProspectConversions, mergeLeadGenResparkPerformance } from "../../analytics/merge/leadGen";
const adapter = <T>(merge: (history: T, live: T) => T) => (history: unknown, live: unknown): unknown => merge(history as T, live as T);
const merges = {
    "scorecard.funnel": adapter(mergeFunnel), "scorecard.cash": adapter(mergeCash),
    "scorecard.follow_through": adapter(mergeFollowThrough), "scorecard.origins": adapter(mergeOrigins),
    "calls.summary": adapter(mergeCallsSummary), "people.closers": adapter(mergePeopleClosers),
    "people.setters": adapter(mergePeopleRoles), "people.dm_closers": adapter(mergePeopleRoles), "people.lead_gen": adapter(mergePeopleRoles),
    "attribution.lanes": adapter(mergeAttributionLanes), "attribution.paths": adapter(mergeAttributionPaths),
    "qualifications.dashboard": adapter(mergeQualificationsDashboard),
    "lead_gen.overview": adapter(mergeLeadGenOverview), "lead_gen.workers": adapter(mergeLeadGenWorkers),
    "lead_gen.top_origins_by_team": adapter(mergeLeadGenTopOriginsByTeam), "lead_gen.prospect_conversions": adapter(mergeLeadGenProspectConversions),
    "lead_gen.respark_performance": adapter(mergeLeadGenResparkPerformance),
};
/** Join complete inputs using the exact merge imported by the page. */
export function mergeReportPanel(id: string, history: unknown, live: unknown): unknown {
    const merge = merges[id as keyof typeof merges];
    if (!merge) throw new Error("This panel cannot be split.");
    return merge(history, live);
}
