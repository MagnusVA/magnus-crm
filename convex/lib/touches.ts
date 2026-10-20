import type { Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { mergedLeadIds } from "./mergedLeads";
import type {
  touchChannelValidator,
  touchSnapshotValidator,
} from "./touchValidators";

// First and latest touch (docs/plans/phase-3-attribution.md §4.5). A touch is
// an event that brought the team into contact with the person through a
// channel. Outcomes, payments, follow-ups and stage changes stay on the
// timeline but are not touches here.

export type TouchChannel = Infer<typeof touchChannelValidator>;
export type TouchSnapshot = Infer<typeof touchSnapshotValidator>;

type ReadCtx = QueryCtx | MutationCtx;

const CHANNEL_BY_EVENT_TYPE: Record<string, TouchChannel> = {
  "lead.captured": "lead_gen",
  "lead.portal_note_added": "dm_portal",
  "lead.portal_profile_updated": "dm_portal",
  "lead.portal_link_copied": "dm_portal",
  "lead.slack_qualified": "slack",
  "meeting.created": "calendly",
};

/**
 * The channel of a touch event, or null when the event isn't a touch. A
 * Slack or side deal's `opportunity.created` is a touch, since the 155 Slack
 * deals older than the qualification events have no other one. A Calendly
 * deal's `opportunity.created` isn't: its booking's `meeting.created` is.
 */
export function touchChannel(
  eventType: string,
  metadataSource: unknown,
): TouchChannel | null {
  const channel = CHANNEL_BY_EVENT_TYPE[eventType];
  if (channel) return channel;
  if (eventType === "opportunity.created") {
    if (metadataSource === "slack_qualified") return "slack";
    if (metadataSource === "side_deal") return "side_deal";
  }
  return null;
}

function storedMetadataSource(metadata: string | undefined): unknown {
  if (!metadata) return undefined;
  try {
    const parsed: unknown = JSON.parse(metadata);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>).source
      : undefined;
  } catch {
    return undefined;
  }
}

/** The touch a stored event is, or null when it isn't one. */
export function touchOfEvent(
  event: Pick<Doc<"domainEvents">, "_id" | "eventType" | "occurredAt" | "metadata">,
): TouchSnapshot | null {
  const channel = touchChannel(
    event.eventType,
    event.eventType === "opportunity.created"
      ? storedMetadataSource(event.metadata)
      : undefined,
  );
  return channel
    ? {
        eventId: event._id,
        eventType: event.eventType,
        channel,
        occurredAt: event.occurredAt,
      }
    : null;
}

/** The earlier of two touches; a tie keeps the first argument. */
export function earlierTouch(
  a: TouchSnapshot | undefined,
  b: TouchSnapshot | undefined,
): TouchSnapshot | undefined {
  if (!a) return b;
  if (!b) return a;
  return b.occurredAt < a.occurredAt ? b : a;
}

/** The later of two touches; a tie keeps the first argument. */
export function laterTouch(
  a: TouchSnapshot | undefined,
  b: TouchSnapshot | undefined,
): TouchSnapshot | undefined {
  if (!a) return b;
  if (!b) return a;
  return b.occurredAt > a.occurredAt ? b : a;
}

/**
 * Called by `emitDomainEvent` for every event it inserts. First touch is the
 * earliest touch: a new touch is later and never replaces it, but a webhook
 * processed late can carry an earlier time. Latest touch moves to every touch
 * at or after it. `updatedAt` stays, so the search projection doesn't change.
 */
export async function recordPersonTouch(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    leadId: Id<"leads"> | undefined;
    eventId: Id<"domainEvents">;
    eventType: string;
    occurredAt: number;
    metadataSource: unknown;
  },
): Promise<void> {
  if (!args.leadId) return;
  const channel = touchChannel(args.eventType, args.metadataSource);
  if (!channel) return;
  const lead = await ctx.db.get("leads", args.leadId);
  if (!lead || lead.tenantId !== args.tenantId || lead.status === "merged") {
    return;
  }
  const touch: TouchSnapshot = {
    eventId: args.eventId,
    eventType: args.eventType,
    channel,
    occurredAt: args.occurredAt,
  };
  const patch: Partial<Pick<Doc<"leads">, "firstTouch" | "latestTouch">> = {};
  if (!lead.firstTouch || touch.occurredAt < lead.firstTouch.occurredAt) {
    patch.firstTouch = touch;
  }
  if (!lead.latestTouch || touch.occurredAt >= lead.latestTouch.occurredAt) {
    patch.latestTouch = touch;
  }
  if (patch.firstTouch || patch.latestTouch) {
    await ctx.db.patch("leads", lead._id, patch);
  }
}

/** The surviving person's touches after `source` merges into `target`. */
export function mergedTouches(
  target: Pick<Doc<"leads">, "firstTouch" | "latestTouch">,
  source: Pick<Doc<"leads">, "firstTouch" | "latestTouch">,
): Partial<Pick<Doc<"leads">, "firstTouch" | "latestTouch">> {
  const firstTouch = earlierTouch(target.firstTouch, source.firstTouch);
  const latestTouch = laterTouch(target.latestTouch, source.latestTouch);
  const patch: Partial<Pick<Doc<"leads">, "firstTouch" | "latestTouch">> = {};
  if (firstTouch && firstTouch !== target.firstTouch) patch.firstTouch = firstTouch;
  if (latestTouch && latestTouch !== target.latestTouch) patch.latestTouch = latestTouch;
  return patch;
}

// Far above any person's events; past it a scan throws rather than guess.
const PERSON_EVENT_SCAN_LIMIT = 5000;

async function scanForTouch(
  ctx: ReadCtx,
  args: {
    tenantId: Id<"tenants">;
    leadId: Id<"leads">;
    order: "asc" | "desc";
    atOrBefore?: number;
  },
): Promise<TouchSnapshot | undefined> {
  let scanned = 0;
  for await (const event of ctx.db
    .query("domainEvents")
    .withIndex("by_tenantId_and_leadId_and_occurredAt", (q) => {
      const range = q.eq("tenantId", args.tenantId).eq("leadId", args.leadId);
      return args.atOrBefore === undefined
        ? range
        : range.lte("occurredAt", args.atOrBefore);
    })
    .order(args.order)) {
    scanned += 1;
    if (scanned > PERSON_EVENT_SCAN_LIMIT) {
      throw new Error(
        `Lead ${args.leadId} has more than ${PERSON_EVENT_SCAN_LIMIT} events`,
      );
    }
    const touch = touchOfEvent(event);
    if (touch) return touch;
  }
  return undefined;
}

/**
 * The person's earliest and latest touch from the event log, across every
 * lead merged into them, optionally only touches at or before a time. The
 * backfills and asserts use it; live writes go through `recordPersonTouch`.
 */
export async function computePersonTouches(
  ctx: ReadCtx,
  args: {
    tenantId: Id<"tenants">;
    leadId: Id<"leads">;
    atOrBefore?: number;
  },
): Promise<{ firstTouch?: TouchSnapshot; latestTouch?: TouchSnapshot }> {
  let firstTouch: TouchSnapshot | undefined;
  let latestTouch: TouchSnapshot | undefined;
  for (const leadId of await mergedLeadIds(ctx, args.tenantId, args.leadId)) {
    const scan = { tenantId: args.tenantId, leadId, atOrBefore: args.atOrBefore };
    firstTouch = earlierTouch(firstTouch, await scanForTouch(ctx, { ...scan, order: "asc" }));
    latestTouch = laterTouch(latestTouch, await scanForTouch(ctx, { ...scan, order: "desc" }));
  }
  return { firstTouch, latestTouch };
}

/**
 * The event that created a deal, as a touch: a Slack or side deal's
 * `opportunity.created`, or a Calendly deal's first booking's
 * `meeting.created`.
 */
async function creatingTouch(
  ctx: ReadCtx,
  opportunity: Doc<"opportunities">,
): Promise<TouchSnapshot | undefined> {
  const entity =
    opportunity.source === "slack_qualified" || opportunity.source === "side_deal"
      ? { entityType: "opportunity", entityId: opportunity._id as string, eventType: "opportunity.created" }
      : await (async () => {
          const meeting = await ctx.db
            .query("meetings")
            .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunity._id))
            .first();
          return meeting
            ? { entityType: "meeting", entityId: meeting._id as string, eventType: "meeting.created" }
            : null;
        })();
  if (!entity) return undefined;
  const events = await ctx.db
    .query("domainEvents")
    .withIndex("by_tenantId_and_entityType_and_entityId_and_occurredAt", (q) =>
      q
        .eq("tenantId", opportunity.tenantId)
        .eq("entityType", entity.entityType as Doc<"domainEvents">["entityType"])
        .eq("entityId", entity.entityId),
    )
    .take(100);
  for (const event of events) {
    if (event.eventType !== entity.eventType) continue;
    const touch = touchOfEvent(event);
    if (touch) return touch;
  }
  return undefined;
}

/**
 * A deal's snapshot as the backfill and assert compute it: the person's
 * touches at or before the deal's creation, plus the event that created it.
 */
export async function computeDealTouches(
  ctx: ReadCtx,
  opportunity: Doc<"opportunities">,
): Promise<{ firstTouch?: TouchSnapshot; latestTouch?: TouchSnapshot }> {
  const person = await computePersonTouches(ctx, {
    tenantId: opportunity.tenantId,
    leadId: opportunity.leadId,
    atOrBefore: opportunity.createdAt,
  });
  const creating = await creatingTouch(ctx, opportunity);
  return {
    firstTouch: earlierTouch(person.firstTouch, creating),
    latestTouch: laterTouch(person.latestTouch, creating),
  };
}

/**
 * Snapshots the person's touches onto a deal, once. Live writes call it after
 * the event that created the deal, and it computes the snapshot the way the
 * backfill does. The snapshot is frozen: a merge or a webhook processed late
 * can change what `computeDealTouches` returns later, never the snapshot.
 */
export async function snapshotDealTouches(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
): Promise<Doc<"opportunities"> | null> {
  const opportunity = await ctx.db.get("opportunities", opportunityId);
  if (!opportunity || opportunity.firstTouch || opportunity.latestTouch) {
    return opportunity;
  }
  const { firstTouch, latestTouch } = await computeDealTouches(ctx, opportunity);
  if (!firstTouch && !latestTouch) return opportunity;
  const patch = { firstTouch, latestTouch };
  await ctx.db.patch("opportunities", opportunity._id, patch);
  return { ...opportunity, ...patch };
}

/** Whether two snapshots name the same event. */
export function sameTouch(
  a: TouchSnapshot | undefined,
  b: TouchSnapshot | undefined,
): boolean {
  return (a?.eventId ?? null) === (b?.eventId ?? null);
}
