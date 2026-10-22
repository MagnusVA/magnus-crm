import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import { ENROLLMENT_STATUS_LABELS, type EnrollmentStatus } from "../enrollments/validators";
import { LIFECYCLE_STAGE_LABELS, type LifecycleStage } from "../leads/lifecycle";
import { dealEventOutcomes, dealEventStateLabel } from "../opportunities/stageLabels";
import { EVENT_LABELS } from "../reporting/lib/eventLabels";
import { getUserDisplayName } from "../reporting/lib/helpers";
import { requireTenantUser } from "../requireTenantUser";
import { mergedLeadIds } from "../lib/mergedLeads";
import {
  createLiveReadState,
  LIVE_QUERY_BYTE_BUDGET,
  readLiveQueryRows,
} from "../lib/liveQueryBounds";
import { canViewPaymentDetail, isAdminRole } from "./permissions";

// One timeline per person, read from `domainEvents` by `leadId`
// (docs/plans/phase-2-person-first.md §6.1): the person's own events and
// those of the leads merged into them, newest first.

export const TIMELINE_PAGE_SIZE = 100;
const TIMELINE_MAX_LIMIT = 1000;

export type TimelineEntry = {
  eventId: Id<"domainEvents">;
  eventType: string;
  occurredAt: number;
  label: string;
  actorName: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  detail: string | null;
};

function parseMetadata(metadata: string | undefined): Record<string, unknown> {
  if (!metadata) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(metadata);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function stageLabel(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  return LIFECYCLE_STAGE_LABELS[value as LifecycleStage] ?? value;
}

function enrollmentStatusLabel(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  return ENROLLMENT_STATUS_LABELS[value as EnrollmentStatus] ?? value;
}

function isEnrollmentEvent(event: Doc<"domainEvents">): boolean {
  return event.entityType === "enrollment";
}

const TOUCH_LABELS: Record<string, string> = {
  "lead.captured": "Captured by lead gen",
  "lead.capture_voided": "Lead gen capture voided",
  "lead.portal_link_copied": "Booking link sent from the DM portal",
  "lead.portal_note_added": "Note added in the DM portal",
  "lead.portal_profile_updated": "Profile updated in the DM portal",
  "lead.slack_qualified": "Qualified in Slack",
  "lead.lifecycle_stage_changed": "Stage changed",
  "lead.disposition_changed": "Disposition changed",
};

/**
 * What the timeline shows for one event. Unknown types show their name. An
 * enrollment event names its program and the admin's reason.
 */
function describe(
  event: Doc<"domainEvents">,
  programName: string | null,
): Pick<TimelineEntry, "label" | "detail" | "fromStatus" | "toStatus"> {
  const metadata = parseMetadata(event.metadata);
  const isStage = event.eventType === "lead.lifecycle_stage_changed";
  const label =
    TOUCH_LABELS[event.eventType] ??
    (EVENT_LABELS[event.eventType]
      ? capitalize(EVENT_LABELS[event.eventType].verb)
      : event.eventType);
  let detail: string | null = null;
  if (event.eventType === "lead.captured" || event.eventType === "lead.capture_voided") {
    detail = [metadata.source, metadata.originKind].filter((part) => typeof part === "string").join(" · ") || null;
  } else if (event.eventType === "lead.portal_link_copied" && typeof metadata.utmCampaign === "string") {
    detail = `Campaign ${metadata.utmCampaign}`;
  } else if (isEnrollmentEvent(event)) {
    detail = [programName, event.reason].filter((part) => part).join(" · ") || null;
  }
  if (event.entityType === "opportunity") {
    // An old deal event holds statuses; a new one, stages with the outcomes
    // in its metadata (docs/plans/phase-5-deal-status.md §4.7).
    const { fromOutcome, toOutcome } = dealEventOutcomes(metadata);
    return {
      label,
      detail,
      fromStatus: dealEventStateLabel(event.fromStatus, fromOutcome),
      toStatus: dealEventStateLabel(event.toStatus, toOutcome),
    };
  }
  const statusLabel = isStage
    ? stageLabel
    : isEnrollmentEvent(event)
      ? enrollmentStatusLabel
      : (value: string | undefined) => value ?? null;
  return {
    label,
    detail,
    fromStatus: statusLabel(event.fromStatus),
    toStatus: statusLabel(event.toStatus),
  };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

async function actorName(
  ctx: QueryCtx,
  event: Doc<"domainEvents">,
  cache: Map<string, string | null>,
): Promise<string | null> {
  const key = event.teamMemberId ?? event.actorUserId;
  if (!key) {
    return null;
  }
  if (!cache.has(key)) {
    let name: string | null = null;
    if (event.teamMemberId) {
      name = (await ctx.db.get("teamMembers", event.teamMemberId))?.displayName ?? null;
    }
    if (!name && event.actorUserId) {
      name = getUserDisplayName(await ctx.db.get("users", event.actorUserId));
    }
    cache.set(key, name);
  }
  return cache.get(key) ?? null;
}

/** The current name of the program an enrollment event names in its metadata. */
async function eventProgramName(
  ctx: QueryCtx,
  event: Doc<"domainEvents">,
  cache: Map<string, string | null>,
): Promise<string | null> {
  if (!isEnrollmentEvent(event)) {
    return null;
  }
  const value = parseMetadata(event.metadata).programId;
  const programId = typeof value === "string" ? ctx.db.normalizeId("tenantPrograms", value) : null;
  if (!programId) {
    return null;
  }
  if (!cache.has(programId)) {
    const program = await ctx.db.get("tenantPrograms", programId);
    cache.set(programId, program && program.tenantId === event.tenantId ? program.name : null);
  }
  return cache.get(programId) ?? null;
}

/** A closer sees the payments they could open on the person page, and no others. */
async function canSeeEvent(
  ctx: QueryCtx,
  event: Doc<"domainEvents">,
  viewer: { userId: Id<"users">; role: Parameters<typeof isAdminRole>[0] },
): Promise<boolean> {
  if (isAdminRole(viewer.role) || event.entityType !== "payment") {
    return true;
  }
  const paymentId = ctx.db.normalizeId("paymentRecords", event.entityId);
  const payment = paymentId && (await ctx.db.get("paymentRecords", paymentId));
  if (!payment) {
    return false;
  }
  const opportunity = payment.opportunityId ? await ctx.db.get("opportunities", payment.opportunityId) : null;
  return canViewPaymentDetail({
    viewerUserId: viewer.userId,
    viewerRole: viewer.role,
    payment,
    opportunityById: new Map(opportunity ? [[opportunity._id, opportunity]] : []),
  });
}

const timelineEntryValidator = v.object({
  eventId: v.id("domainEvents"),
  eventType: v.string(),
  occurredAt: v.number(),
  label: v.string(),
  actorName: v.union(v.string(), v.null()),
  fromStatus: v.union(v.string(), v.null()),
  toStatus: v.union(v.string(), v.null()),
  detail: v.union(v.string(), v.null()),
});

export const getLeadTimeline = query({
  args: { leadId: v.id("leads"), limit: v.optional(v.number()) },
  returns: v.union(
    v.null(),
    v.object({
      entries: v.array(timelineEntryValidator),
      hasMore: v.boolean(),
      // The read stopped at its byte budget or the largest page, so older
      // events exist that the page doesn't show.
      capped: v.boolean(),
      limit: v.number(),
    }),
  ),
  handler: async (ctx, { leadId, limit }) => {
    const { tenantId, userId, role } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
      "closer",
    ]);
    const lead = await ctx.db.get("leads", leadId);
    if (!lead || lead.tenantId !== tenantId) {
      return null;
    }
    const pageLimit = Math.min(Math.max(1, Math.floor(limit ?? TIMELINE_PAGE_SIZE)), TIMELINE_MAX_LIMIT);

    // One byte budget for the whole read; each lead reads at most a page.
    let bytesLeft = LIVE_QUERY_BYTE_BUDGET;
    let moreEvents = false;
    let budgetHit = false;
    const events: Doc<"domainEvents">[] = [];
    for (const id of await mergedLeadIds(ctx, tenantId, leadId)) {
      if (bytesLeft <= 0) {
        budgetHit = true;
        break;
      }
      const state = createLiveReadState();
      const read = await readLiveQueryRows(
        ctx.db
          .query("domainEvents")
          .withIndex("by_tenantId_and_leadId_and_occurredAt", (q) => q.eq("tenantId", tenantId).eq("leadId", id))
          .order("desc"),
        pageLimit,
        state,
        bytesLeft,
      );
      bytesLeft -= state.bytesRead;
      events.push(...read.rows);
      if (read.capped) {
        if (read.rows.length >= pageLimit) {
          moreEvents = true;
        } else {
          budgetHit = true;
        }
      }
    }
    const merged = events.sort(
      (left, right) => right.occurredAt - left.occurredAt || right._creationTime - left._creationTime,
    );
    moreEvents ||= merged.length > pageLimit;
    const atLargestPage = pageLimit >= TIMELINE_MAX_LIMIT;

    const names = new Map<string, string | null>();
    const programNames = new Map<string, string | null>();
    const entries: TimelineEntry[] = [];
    for (const event of merged.slice(0, pageLimit)) {
      if (!(await canSeeEvent(ctx, event, { userId, role }))) {
        continue;
      }
      entries.push({
        eventId: event._id,
        eventType: event.eventType,
        occurredAt: event.occurredAt,
        actorName: await actorName(ctx, event, names),
        ...describe(event, await eventProgramName(ctx, event, programNames)),
      });
    }
    return {
      entries,
      hasMore: moreEvents && !budgetHit && !atLargestPage,
      capped: budgetHit || (moreEvents && atLargestPage),
      limit: pageLimit,
    };
  },
});
