import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { followMergeChain } from "../leads/identityResolution";
import { executeMerge } from "../leads/merge";
import {
  createLiveReadState,
  LIVE_QUERY_BYTE_BUDGET,
  readLiveDocuments,
  readLiveQueryRows,
} from "../lib/liveQueryBounds";
import { areNamesSimilar } from "../lib/normalization";
import { log } from "../lib/observability/log";
import { getString, isRecord } from "../lib/payloadExtraction";
import { requireTenantUser } from "../requireTenantUser";
import type { IdentityMatchVia } from "./blocked";
import {
  closeKeptSeparateSiblings,
  closeMergedReviews,
  resolveBookingReview,
  retryMergedHold,
  reviewPeople,
} from "./bookingReviewRecords";
import { retryDelivery } from "./recovery";

const ADMIN_ROLES = ["tenant_master", "tenant_admin"] as const;
const LIST_PAGE_LIMIT = 50;
const OPEN_COUNT_LIMIT = 99;
const DEALS_PER_PERSON = 10;
const IDENTIFIERS_PER_PERSON = 20;

export type BookingReviewPerson = {
  leadId: Id<"leads">;
  /** "booked": the booking applied to them. "matched": the booking also named them. */
  role: "booked" | "matched";
  matchedBy: IdentityMatchVia[];
  /** Which of the booking's details agree with this person's. */
  checks: { label: "name" | "email" | "phone" | "Instagram"; same: boolean }[];
  name?: string;
  email?: string;
  phone?: string;
  status: Doc<"leads">["status"];
  mergedIntoLeadId?: Id<"leads">;
  firstSeenAt: number;
  handles: { type: string; handle: string }[];
  identifiers: { type: string; value: string; source: string; createdAt: number }[];
  deals: {
    opportunityId: Id<"opportunities">;
    status: Doc<"opportunities">["status"];
    source?: Doc<"opportunities">["source"];
    createdAt: number;
    hostName?: string;
    closerName?: string;
    qualifiedByName?: string;
    latestMeetingAt?: number;
  }[];
};

export type BookingReviewDetail = {
  reviewId: Id<"bookingReviews">;
  kind: Doc<"bookingReviews">["kind"];
  status: Doc<"bookingReviews">["status"];
  reason?: string;
  resolution?: Doc<"bookingReviews">["resolution"];
  resolvedAt?: number;
  resolvedByName?: string;
  createdAt: number;
  deliveryId: Id<"webhookDeliveries">;
  deliveryStatus?: Doc<"webhookDeliveries">["status"];
  booking: {
    inviteeName?: string;
    email?: string;
    phone?: string;
    socialHandle?: { platform: string; handle: string };
    timezone?: string;
    eventName?: string;
    startTime?: number;
    endTime?: number;
    hostName?: string;
    hostEmail?: string;
    bookedVia?: string;
    answers: { question: string; answer: string }[];
    meetingId?: Id<"meetings">;
    opportunityId?: Id<"opportunities">;
    /** False once the raw payload is past retention: only identifiers remain. */
    payloadAvailable: boolean;
  };
  people: BookingReviewPerson[];
};

function parseTime(value: unknown) {
  if (typeof value !== "string") return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : undefined;
}

/** The booking as Calendly sent it, while the raw payload is retained. */
async function readBookingPayload(
  ctx: QueryCtx,
  delivery: Doc<"webhookDeliveries"> | null,
) {
  const raw = delivery ? await ctx.db.get("rawWebhookEvents", delivery.rawEventId) : null;
  if (!raw) return null;
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw.payload);
  } catch {
    return null;
  }
  if (!isRecord(envelope) || !isRecord(envelope.payload)) return null;
  const payload = envelope.payload;
  const event = isRecord(payload.scheduled_event) ? payload.scheduled_event : {};
  const host = Array.isArray(event.event_memberships) && isRecord(event.event_memberships[0])
    ? event.event_memberships[0]
    : {};
  const tracking = isRecord(payload.tracking) ? payload.tracking : {};
  const bookedVia = [getString(tracking, "utm_source"), getString(tracking, "utm_medium")]
    .filter(Boolean)
    .join(" / ");
  const answers = Array.isArray(payload.questions_and_answers)
    ? payload.questions_and_answers.flatMap((qa) => {
        if (!isRecord(qa)) return [];
        const question = getString(qa, "question")?.trim();
        const answer = getString(qa, "answer")?.trim();
        return question && answer ? [{ question, answer }] : [];
      })
    : [];
  return {
    inviteeName: getString(payload, "name"),
    email: getString(payload, "email"),
    timezone: getString(payload, "timezone"),
    eventName: getString(event, "name"),
    startTime: parseTime(event.start_time),
    endTime: parseTime(event.end_time),
    hostName: getString(host, "user_name"),
    hostEmail: getString(host, "user_email"),
    bookedVia: bookedVia || undefined,
    answers,
  };
}

async function loadPerson(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  leadId: Id<"leads">,
  role: BookingReviewPerson["role"],
  matchedBy: IdentityMatchVia[],
): Promise<Omit<BookingReviewPerson, "checks"> | null> {
  const lead = await ctx.db.get("leads", leadId);
  if (!lead || lead.tenantId !== tenantId) return null;
  const [identifiers, opportunities] = await Promise.all([
    ctx.db
      .query("leadIdentifiers")
      .withIndex("by_leadId", (q) => q.eq("leadId", leadId))
      .take(IDENTIFIERS_PER_PERSON),
    ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_leadId", (q) =>
        q.eq("tenantId", tenantId).eq("leadId", leadId),
      )
      .order("desc")
      .take(DEALS_PER_PERSON),
  ]);
  const deals = await Promise.all(
    opportunities.map(async (opportunity) => {
      const closer = opportunity.assignedCloserId
        ? await ctx.db.get("users", opportunity.assignedCloserId)
        : null;
      const slackUserId = opportunity.qualifiedBy?.slackUserId;
      const setter = slackUserId
        ? await ctx.db
            .query("slackUsers")
            .withIndex("by_tenantId_and_slackUserId", (q) =>
              q.eq("tenantId", tenantId).eq("slackUserId", slackUserId),
            )
            .unique()
        : null;
      return {
        opportunityId: opportunity._id,
        status: opportunity.status,
        source: opportunity.source,
        createdAt: opportunity.createdAt,
        hostName: opportunity.hostCalendlyName,
        closerName: closer?.fullName ?? closer?.email,
        qualifiedByName: setter?.realName ?? setter?.displayName ?? slackUserId,
        latestMeetingAt: opportunity.latestMeetingAt,
      };
    }),
  );
  return {
    leadId,
    role,
    matchedBy,
    name: lead.fullName,
    email: lead.email,
    phone: lead.phone,
    status: lead.status,
    mergedIntoLeadId: lead.mergedIntoLeadId,
    firstSeenAt: lead.firstSeenAt,
    handles: lead.socialHandles ?? [],
    identifiers: identifiers.map((identifier) => ({
      type: identifier.type,
      value: identifier.value,
      source: identifier.source,
      createdAt: identifier.createdAt,
    })),
    deals,
  };
}

function compareBookingWithPerson(
  booking: BookingReviewDetail["booking"],
  person: Omit<BookingReviewPerson, "checks">,
): BookingReviewPerson["checks"] {
  const values = (type: string) =>
    person.identifiers.filter((i) => i.type === type).map((i) => i.value);
  const checks: BookingReviewPerson["checks"] = [];
  if (booking.inviteeName && person.name)
    checks.push({ label: "name", same: areNamesSimilar(booking.inviteeName, person.name) });
  if (booking.email)
    checks.push({
      label: "email",
      same: values("email").includes(booking.email) || person.email === booking.email,
    });
  if (booking.phone && values("phone").length)
    checks.push({ label: "phone", same: values("phone").includes(booking.phone) });
  const handle = booking.socialHandle;
  if (handle && values(handle.platform).length)
    checks.push({ label: "Instagram", same: values(handle.platform).includes(handle.handle) });
  return checks;
}

export async function loadBookingReviewDetail(
  ctx: QueryCtx,
  review: Doc<"bookingReviews">,
): Promise<BookingReviewDetail> {
  const delivery = await ctx.db.get("webhookDeliveries", review.deliveryId);
  const payload = await readBookingPayload(ctx, delivery);
  const matchedBy = new Map<Id<"leads">, IdentityMatchVia[]>();
  for (const conflict of review.conflicts)
    matchedBy.set(conflict.leadId, [...(matchedBy.get(conflict.leadId) ?? []), conflict.via]);
  const people = await Promise.all([
    ...(review.leadId
      ? [loadPerson(ctx, review.tenantId, review.leadId, "booked", ["social_handle"])]
      : []),
    ...[...matchedBy].map(([leadId, vias]) =>
      loadPerson(ctx, review.tenantId, leadId, "matched", vias),
    ),
  ]);
  const bookingDetail: BookingReviewDetail["booking"] = {
    ...payload,
    inviteeName: payload?.inviteeName ?? review.booking.name,
    email: review.booking.email ?? payload?.email,
    phone: review.booking.phone,
    socialHandle: review.booking.socialHandle,
    answers: payload?.answers ?? [],
    meetingId: delivery?.meetingId,
    opportunityId: delivery?.opportunityId,
    payloadAvailable: payload !== null,
  };
  const resolvedBy = review.resolvedByUserId
    ? await ctx.db.get("users", review.resolvedByUserId)
    : null;
  return {
    reviewId: review._id,
    kind: review.kind,
    status: review.status,
    reason: review.reason,
    resolution: review.resolution,
    resolvedAt: review.resolvedAt,
    resolvedByName: resolvedBy?.fullName ?? resolvedBy?.email,
    createdAt: review.createdAt,
    deliveryId: review.deliveryId,
    deliveryStatus: delivery?.status,
    booking: bookingDetail,
    people: people.flatMap((person) =>
      person ? [{ ...person, checks: compareBookingWithPerson(bookingDetail, person) }] : [],
    ),
  };
}

async function requireReview(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  reviewId: Id<"bookingReviews">,
) {
  const review = await ctx.db.get("bookingReviews", reviewId);
  if (!review || review.tenantId !== tenantId) throw new Error("Booking review not found");
  return review;
}

/** Open reviews, newest first, a page at a time. */
export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    const { tenantId } = await requireTenantUser(ctx, [...ADMIN_ROLES]);
    const page = await ctx.db
      .query("bookingReviews")
      .withIndex("by_tenantId_and_status_and_createdAt", (q) =>
        q.eq("tenantId", tenantId).eq("status", "open"),
      )
      .order("desc")
      .paginate({
        ...paginationOpts,
        numItems: Math.min(paginationOpts.numItems, LIST_PAGE_LIMIT),
        maximumRowsRead: LIST_PAGE_LIMIT,
        maximumBytesRead: LIVE_QUERY_BYTE_BUDGET,
      });
    // The people's names share one byte budget across the page; past it, the
    // rest show as unnamed and the row's `namesCapped` says so.
    const names = createLiveReadState();
    const rows = [];
    for (const review of page.page) {
      const leadIds = [
        ...(review.leadId ? [review.leadId] : []),
        ...new Set(review.conflicts.map((c) => c.leadId)),
      ];
      const { rows: leads, capped: namesCapped } = await readLiveDocuments(
        leadIds,
        (id) => ctx.db.get("leads", id),
        names,
      );
      const nameOf = (id: Id<"leads">) => {
        const lead = leads.find((l) => l._id === id);
        return lead?.fullName ?? lead?.email;
      };
      rows.push({
        reviewId: review._id,
        kind: review.kind,
        reason: review.reason,
        createdAt: review.createdAt,
        bookingName: review.booking.name,
        bookedLeadName: review.leadId ? nameOf(review.leadId) : undefined,
        otherNames: [...new Set(review.conflicts.map((c) => c.leadId))].map(
          (id) => nameOf(id) ?? "Unnamed person",
        ),
        matchedBy: [...new Set(review.conflicts.map((c) => c.via))],
        namesCapped,
      });
    }
    return { ...page, page: rows };
  },
});

/** How many reviews are open, for the Operations banner; `capped` past the bound. */
export const openCount = query({
  args: {},
  returns: v.object({ count: v.number(), capped: v.boolean() }),
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [...ADMIN_ROLES]);
    // A bounded live read, not an aggregate: the banner shows "99+" past the
    // bound, and the queue is empty on most days.
    const { rows, capped } = await readLiveQueryRows(
      ctx.db
        .query("bookingReviews")
        .withIndex("by_tenantId_and_status_and_createdAt", (q) =>
          q.eq("tenantId", tenantId).eq("status", "open"),
        ),
      OPEN_COUNT_LIMIT,
    );
    return { count: rows.length, capped };
  },
});

/** Takes the raw URL segment, so a truncated Slack link reads as not found. */
export const get = query({
  args: { reviewId: v.string() },
  handler: async (ctx, { reviewId }) => {
    const { tenantId } = await requireTenantUser(ctx, [...ADMIN_ROLES]);
    const id = ctx.db.normalizeId("bookingReviews", reviewId);
    const review = id ? await ctx.db.get("bookingReviews", id) : null;
    if (!review || review.tenantId !== tenantId) return null;
    return await loadBookingReviewDetail(ctx, review);
  },
});

/** The review as its Slack alert shows it. */
export const getForAlert = internalQuery({
  args: { reviewId: v.id("bookingReviews") },
  handler: async (ctx, { reviewId }) => {
    const review = await ctx.db.get("bookingReviews", reviewId);
    if (!review) return null;
    return {
      tenantId: review.tenantId,
      alertPostedAt: review.alertPostedAt,
      detail: await loadBookingReviewDetail(ctx, review),
    };
  },
});

function requireOpen(review: Doc<"bookingReviews">) {
  if (review.status !== "open") throw new Error("This booking review is already resolved");
}

const decisionResult = v.object({ alsoClosed: v.number() });

/**
 * The people are one person: everyone the booking named is merged into
 * `keepLeadId`. A held booking is then retried, and applies to that person.
 * Other open reviews the merge leaves with one person close with it.
 */
export const mergePeople = mutation({
  args: { reviewId: v.id("bookingReviews"), keepLeadId: v.id("leads") },
  returns: decisionResult,
  handler: async (ctx, { reviewId, keepLeadId }) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [...ADMIN_ROLES]);
    const review = await requireReview(ctx, tenantId, reviewId);
    requireOpen(review);
    const named = [review.leadId, ...review.conflicts.map((c) => c.leadId)].filter(
      (id): id is Id<"leads"> => id !== undefined,
    );
    if (!named.includes(keepLeadId)) throw new Error("Keep one of the people this booking named");
    // Someone may have merged one of them since; merge what they became.
    const people = await reviewPeople(ctx, review);
    const keep = await ctx.db.get("leads", keepLeadId);
    const target = keep && (await followMergeChain(ctx, keep));
    if (!target) throw new Error("The person to keep no longer exists");
    for (const leadId of people) {
      if (leadId !== target._id) await executeMerge(ctx, tenantId, userId, leadId, target._id);
    }
    await resolveBookingReview(ctx, review, userId, "merged");
    await retryMergedHold(ctx, review, userId);
    return { alsoClosed: await closeMergedReviews(ctx, tenantId, userId) };
  },
});

/**
 * The people are different people. They stay as they are; a held booking
 * stays held, for the recovery panel. Other open reviews about the same
 * people close with it.
 */
export const keepSeparate = mutation({
  args: { reviewId: v.id("bookingReviews") },
  returns: decisionResult,
  handler: async (ctx, { reviewId }) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [...ADMIN_ROLES]);
    const review = await requireReview(ctx, tenantId, reviewId);
    requireOpen(review);
    await resolveBookingReview(ctx, review, userId, "kept_separate");
    return { alsoClosed: await closeKeptSeparateSiblings(ctx, review, userId) };
  },
});

/** Retries a held booking after a fix made elsewhere; the review closes if it applies. */
export const retryBooking = mutation({
  args: { reviewId: v.id("bookingReviews") },
  returns: v.null(),
  handler: async (ctx, { reviewId }) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [...ADMIN_ROLES]);
    const review = await requireReview(ctx, tenantId, reviewId);
    requireOpen(review);
    if (review.kind !== "held") throw new Error("Only a held booking can be retried");
    await retryDelivery(ctx, tenantId, userId, review.deliveryId);
    return null;
  },
});
