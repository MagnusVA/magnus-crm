import type { ReaderArgs } from "../../analytics/assistantTypes";
import { getTenantBusinessDay } from "../../lib/tenantBusinessDay";
import type { Doc } from "../../_generated/dataModel";
import { type QueryCtx } from "../../_generated/server";
import { deriveOverviewRange } from "../../dashboard/overviewRange";
import { listQualificationEventsForRange } from "../../reporting/lib/slackQualificationLedger";
import type { Id } from "../../_generated/dataModel";
import { buildQualificationsDashboard, QualifiedBySlackUser } from "../../operations/qualificationsDashboard";
import type { getQualificationsDashboard } from "../../operations/qualificationsDashboard";
// Trusted tenant readers. Copied load steps preserve page semantics; builders stay shared.
function qualifiedBySlackUser(events: Doc<"slackQualificationEvents">[]) {
    const bySlackUserId = new Map<string, QualifiedBySlackUser>();
    for (const event of events) {
        const current = bySlackUserId.get(event.slackUserId) ?? {
            slackUserId: event.slackUserId,
            qualified: 0,
            lastEventAt: event.submittedAt,
        };
        current.qualified += 1;
        current.lastEventAt = Math.max(current.lastEventAt, event.submittedAt);
        bySlackUserId.set(event.slackUserId, current);
    }
    return [...bySlackUserId.values()];
}
export async function readGetQualificationsDashboard(ctx: QueryCtx, tenantId: Id<"tenants">, args: ReaderArgs<typeof getQualificationsDashboard>) {
    const range = deriveOverviewRange(args.range, Date.now(), await getTenantBusinessDay(ctx, tenantId));
    const tenant = await ctx.db.get("tenants", tenantId);
    if (!tenant) {
        throw new Error("Tenant not found.");
    }
    const events = await listQualificationEventsForRange(ctx, {
        tenantId,
        start: range.slackWindowStart,
        end: range.slackWindowEnd,
    });
    return await buildQualificationsDashboard(ctx, tenant, range, {
        bySlackUser: qualifiedBySlackUser(events.rows),
        truncated: events.truncated,
    });
}
