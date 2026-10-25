import { DirectAggregate } from "@convex-dev/aggregate";
import { components } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { MERGED_SOURCE_LIMIT, mergedLeadIds } from "../mergedLeads";
import { touchChannel } from "../touches";
import { RESPARK_GROUPS, type LastTouch, type ResparkGroup } from "./validators";

// Respark state on the person (docs/plans/respark.md §4.3, §4.4, §5.1):
// `lastTouch`, `resparkGroup`, and the person's `resparkPool` entry. Every
// write goes through `refreshResparkState`, and the backfill and assert
// compute the same values from the records with `computeResparkState`.

type ReadCtx = QueryCtx | MutationCtx;

// One entry per non-merged person with a `lastTouch`, keyed by group and the
// time of that touch, so a bucket or an inactive count is one range count.
// Live writes are strict since its backfill and assert passed (plan §3.5):
// a missing or duplicate entry throws instead of drifting. The rebuild and
// the reset stay tolerant.
export const resparkPool = new DirectAggregate<{
  Namespace: Id<"tenants">;
  Key: [ResparkGroup, number];
  Id: Id<"leads">;
}>(components.resparkPool);

// Respark actions (plan §5.3). They join the event list here so the last
// touch rule is complete before the actions ship.
export const LEAD_RESPARKED = "lead.resparked";
export const LEAD_MARKED_NOT_A_FIT = "lead.marked_not_a_fit";

// A meeting result recorded on the meeting itself. Marking a call held
// usually writes only the deal's move, which the deal rule below counts.
const MEETING_RESULT_EVENTS = new Set(["meeting.no_show", "meeting.canceled"]);
const HELD_MEETING_STATUSES = new Set(["held", "completed"]);
// A deal move or loss counts unless the system made it: the Slack expiry and
// other closings no one did with the person.
const DEAL_MOVE_EVENTS = new Set([
  "opportunity.stage_changed",
  "opportunity.marked_lost",
  "opportunity.status_changed",
]);
const ALWAYS_LAST_TOUCH_EVENTS = new Set([
  "payment.recorded",
  LEAD_RESPARKED,
  LEAD_MARKED_NOT_A_FIT,
]);

export type LastTouchEventFields = {
  eventType: string;
  source: Doc<"domainEvents">["source"];
  toStatus?: string;
  metadataSource: unknown;
};

/** Whether an event is a last touch (plan §4.3, Q3). */
export function isLastTouchEvent(event: LastTouchEventFields): boolean {
  if (touchChannel(event.eventType, event.metadataSource)) return true;
  if (ALWAYS_LAST_TOUCH_EVENTS.has(event.eventType)) return true;
  if (MEETING_RESULT_EVENTS.has(event.eventType)) return true;
  if (event.eventType === "meeting.status_changed") {
    return HELD_MEETING_STATUSES.has(event.toStatus ?? "");
  }
  return DEAL_MOVE_EVENTS.has(event.eventType) && event.source !== "system";
}

// Events that can change a person's group: their stage, disposition or
// status, or one of their deals opening or closing.
const GROUP_EVENTS = new Set([
  "lead.lifecycle_stage_changed",
  "lead.disposition_changed",
  "lead.status_changed",
  "lead.merged",
  "opportunity.created",
  ...DEAL_MOVE_EVENTS,
]);

/** Whether `emitDomainEvent` refreshes the person's respark state. */
export function refreshesResparkState(eventType: string, lastTouch: boolean): boolean {
  return lastTouch || GROUP_EVENTS.has(eventType);
}

/** The pool part a person is in, before any time rule (plan §4.4). */
export function resparkGroupFor(
  lead: Pick<Doc<"leads">, "status" | "lifecycleStage" | "disposition"> & {
    lastTouch?: LastTouch;
  },
  hasOpenDeal: boolean,
): ResparkGroup {
  if (
    lead.status === "merged" ||
    lead.lifecycleStage === "customer" ||
    hasOpenDeal ||
    lead.disposition === "do_not_contact" ||
    !lead.lastTouch
  ) {
    return "out";
  }
  if (lead.disposition === "not_a_fit") return "not_a_fit";
  switch (lead.lifecycleStage) {
    case "qualified":
      return "qualified";
    case "prospect":
    case "in_conversation":
      return "never_qualified";
    case "booked":
    case "showed":
      return "had_call";
  }
}

export async function hasOpenDeal(
  ctx: ReadCtx,
  tenantId: Id<"tenants">,
  leadId: Id<"leads">,
): Promise<boolean> {
  const open = await ctx.db
    .query("opportunities")
    .withIndex("by_tenantId_and_leadId_and_outcome", (q) =>
      q.eq("tenantId", tenantId).eq("leadId", leadId).eq("outcome", "open"),
    )
    .first();
  return open !== null;
}

/**
 * The later of two touches: the later time, and at the same time the event
 * written later, as the event index orders them. Every path picks with this,
 * so the live writes and the recomputation agree.
 */
export async function laterLastTouch(
  ctx: ReadCtx,
  a: LastTouch | undefined,
  b: LastTouch | undefined,
): Promise<LastTouch | undefined> {
  if (!a) return b;
  if (!b) return a;
  if (a.occurredAt !== b.occurredAt) return b.occurredAt > a.occurredAt ? b : a;
  if (a.eventId === b.eventId) return a;
  // A deleted event loses the tie.
  const [eventA, eventB] = await Promise.all([
    ctx.db.get("domainEvents", a.eventId),
    ctx.db.get("domainEvents", b.eventId),
  ]);
  return (eventB?._creationTime ?? 0) > (eventA?._creationTime ?? 0) ? b : a;
}

function poolKey(group: ResparkGroup, lastTouch: LastTouch): [ResparkGroup, number] {
  return [group, lastTouch.occurredAt];
}

/**
 * The pool entry the person's stored fields say they have, if any. A person
 * has one exactly when both fields are set; a merged person has no group.
 */
function storedPoolKey(
  lead: Pick<Doc<"leads">, "resparkGroup" | "lastTouch">,
): [ResparkGroup, number] | null {
  return lead.resparkGroup && lead.lastTouch ? poolKey(lead.resparkGroup, lead.lastTouch) : null;
}

export type ResparkState = {
  lastTouch: LastTouch | undefined;
  /** Undefined for a merged person, who has no pool entry. */
  resparkGroup: ResparkGroup | undefined;
};

/**
 * Writes `lastTouch` and `resparkGroup` when they changed, and moves the
 * person's pool entry with them.
 */
async function writeResparkState(
  ctx: MutationCtx,
  lead: Doc<"leads">,
  next: ResparkState,
  writes: "strict" | "tolerant" = "strict",
): Promise<void> {
  const sameTouch = (lead.lastTouch?.eventId ?? null) === (next.lastTouch?.eventId ?? null);
  if (sameTouch && lead.resparkGroup === next.resparkGroup) return;
  await ctx.db.patch("leads", lead._id, {
    lastTouch: next.lastTouch,
    resparkGroup: next.resparkGroup,
  });
  const before = storedPoolKey(lead);
  const after = storedPoolKey(next);
  const namespace = lead.tenantId;
  const strict = writes === "strict";
  if (before && after) {
    const current = { namespace, key: before, id: lead._id };
    if (strict) await resparkPool.replace(ctx, current, { namespace, key: after });
    else await resparkPool.replaceOrInsert(ctx, current, { namespace, key: after });
  } else if (after) {
    const entry = { namespace, key: after, id: lead._id };
    if (strict) await resparkPool.insert(ctx, entry);
    else await resparkPool.insertIfDoesNotExist(ctx, entry);
  } else if (before) {
    const entry = { namespace, key: before, id: lead._id };
    if (strict) await resparkPool.delete(ctx, entry);
    else await resparkPool.deleteIfExists(ctx, entry);
  }
}

/**
 * Brings the person's respark state up to date after a write: `touch`, if
 * given, is a candidate last touch, and the group is worked out again from
 * the person and their open deals. Called by `emitDomainEvent` and after
 * writes that emit no event (plan §5.1).
 */
export async function refreshResparkState(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  leadId: Id<"leads">,
  touch?: LastTouch,
): Promise<void> {
  const lead = await ctx.db.get("leads", leadId);
  if (!lead || lead.tenantId !== tenantId) return;
  if (lead.status === "merged") {
    await writeResparkState(ctx, lead, { lastTouch: lead.lastTouch, resparkGroup: undefined });
    // A touch on a merged person, such as a capture of a prospect a merge
    // hasn't moved yet, is the survivor's: their history includes it.
    const survivor = touch && (await mergeSurvivor(ctx, lead));
    if (survivor) await refreshResparkState(ctx, tenantId, survivor, touch);
    return;
  }
  const lastTouch = await laterLastTouch(ctx, lead.lastTouch, touch);
  const resparkGroup = resparkGroupFor(
    { ...lead, lastTouch },
    await hasOpenDeal(ctx, lead.tenantId, lead._id),
  );
  await writeResparkState(ctx, lead, { lastTouch, resparkGroup });
}

// A merge repoints earlier merges at its target, so a chain is one hop
// deep; a few more allow for a merge in progress.
const MERGE_CHAIN_LIMIT = 5;

/** The non-merged person a merged one ended up in, in the same tenant. */
async function mergeSurvivor(
  ctx: ReadCtx,
  lead: Doc<"leads">,
): Promise<Id<"leads"> | null> {
  let current = lead;
  for (let hop = 0; hop < MERGE_CHAIN_LIMIT; hop += 1) {
    if (current.status !== "merged") return current._id;
    if (!current.mergedIntoLeadId) return null;
    const next = await ctx.db.get("leads", current.mergedIntoLeadId);
    if (!next || next.tenantId !== lead.tenantId) return null;
    current = next;
  }
  return null;
}

/** Drops the pool entry of a person who is about to be deleted. */
export async function deleteResparkPoolEntry(
  ctx: MutationCtx,
  lead: Doc<"leads">,
): Promise<void> {
  const key = storedPoolKey(lead);
  if (key) {
    await resparkPool.deleteIfExists(ctx, { namespace: lead.tenantId, key, id: lead._id });
  }
}

// --- Backfill and assert (plan §10.1). ---

// Far above any person's events; past it a scan throws rather than guess.
const PERSON_EVENT_SCAN_LIMIT = 5000;

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

/** The last touch a stored event is, or null when it isn't one. */
export function lastTouchOfEvent(event: Doc<"domainEvents">): LastTouch | null {
  const lastTouch = isLastTouchEvent({
    eventType: event.eventType,
    source: event.source,
    toStatus: event.toStatus,
    metadataSource:
      event.eventType === "opportunity.created" ? storedMetadataSource(event.metadata) : undefined,
  });
  return lastTouch
    ? { eventId: event._id, eventType: event.eventType, occurredAt: event.occurredAt }
    : null;
}

async function newestLastTouch(
  ctx: ReadCtx,
  tenantId: Id<"tenants">,
  leadId: Id<"leads">,
): Promise<LastTouch | undefined> {
  let scanned = 0;
  for await (const event of ctx.db
    .query("domainEvents")
    .withIndex("by_tenantId_and_leadId_and_occurredAt", (q) =>
      q.eq("tenantId", tenantId).eq("leadId", leadId),
    )
    .order("desc")) {
    scanned += 1;
    if (scanned > PERSON_EVENT_SCAN_LIMIT) {
      throw new Error(`Lead ${leadId} has more than ${PERSON_EVENT_SCAN_LIMIT} events`);
    }
    const touch = lastTouchOfEvent(event);
    if (touch) return touch;
  }
  return undefined;
}

/**
 * The person's last touch and group from their records: the newest last
 * touch across them and every lead merged into them, and their open deals.
 * A merged person keeps the `lastTouch` it has and has no group.
 */
export async function computeResparkState(
  ctx: ReadCtx,
  lead: Doc<"leads">,
): Promise<ResparkState> {
  if (lead.status === "merged") {
    return { lastTouch: lead.lastTouch, resparkGroup: undefined };
  }
  const leadIds = await mergedLeadIds(ctx, lead.tenantId, lead._id);
  // The walk stops at the limit; past it the history would be partial.
  if (leadIds.length >= MERGED_SOURCE_LIMIT) {
    throw new Error(`Lead ${lead._id} has ${MERGED_SOURCE_LIMIT} or more merged records`);
  }
  let lastTouch: LastTouch | undefined;
  for (const leadId of leadIds) {
    lastTouch = await laterLastTouch(ctx, lastTouch, await newestLastTouch(ctx, lead.tenantId, leadId));
  }
  const resparkGroup = resparkGroupFor(
    { ...lead, lastTouch },
    await hasOpenDeal(ctx, lead.tenantId, lead._id),
  );
  return { lastTouch, resparkGroup };
}

/**
 * Sets the person's respark state from their records. The backfill uses it,
 * and so does any write that deletes events, since the live refresh only
 * moves forward.
 */
export async function recomputeResparkState(
  ctx: MutationCtx,
  lead: Doc<"leads">,
): Promise<void> {
  await writeResparkState(ctx, lead, await computeResparkState(ctx, lead), "tolerant");
  // A first write with the values already stored (a rerun) leaves the
  // entry alone above; make sure it exists.
  const fresh = await ctx.db.get("leads", lead._id);
  const key = fresh && storedPoolKey(fresh);
  if (fresh && key) {
    await resparkPool.insertIfDoesNotExist(ctx, { namespace: fresh.tenantId, key, id: fresh._id });
  }
}

async function hasPoolEntry(
  ctx: ReadCtx,
  lead: Doc<"leads">,
  key: [ResparkGroup, number],
): Promise<boolean> {
  const bound = { key, id: lead._id, inclusive: true };
  return (
    (await resparkPool.count(ctx, {
      namespace: lead.tenantId,
      bounds: { lower: bound, upper: bound },
    })) === 1
  );
}

/** What is wrong with a person's stored respark state. */
export async function resparkStateProblems(
  ctx: ReadCtx,
  lead: Doc<"leads">,
): Promise<string[]> {
  const problems: string[] = [];
  const computed = await computeResparkState(ctx, lead);
  if ((lead.lastTouch?.eventId ?? null) !== (computed.lastTouch?.eventId ?? null)) {
    problems.push(
      `lastTouch ${lead.lastTouch?.eventId ?? "none"}, expected ${computed.lastTouch?.eventId ?? "none"}`,
    );
  }
  if (lead.lastTouch && computed.lastTouch && lead.lastTouch.occurredAt !== computed.lastTouch.occurredAt) {
    problems.push(`lastTouch time ${lead.lastTouch.occurredAt}, expected ${computed.lastTouch.occurredAt}`);
  }
  if (lead.resparkGroup !== computed.resparkGroup) {
    problems.push(`resparkGroup ${lead.resparkGroup ?? "none"}, expected ${computed.resparkGroup}`);
  }
  const key = storedPoolKey(lead);
  if (key && !(await hasPoolEntry(ctx, lead, key))) {
    problems.push(`missing pool entry [${key.join(", ")}]`);
  }
  if (lead.status === "merged" && lead.lastTouch) {
    for (const group of RESPARK_GROUPS) {
      if (await hasPoolEntry(ctx, lead, poolKey(group, lead.lastTouch))) {
        problems.push(`merged lead has a ${group} pool entry`);
      }
    }
  }
  return problems;
}
