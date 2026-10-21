import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import {
  buildOpportunityAttributionSummary,
  resolveBookingDmAttribution,
} from "../lib/attribution/detailPayload";
import {
  slackMemberIdentity,
  unknownMemberIdentity,
  userMemberIdentity,
} from "../lib/memberIdentity";
import {
  resolveLegacyCompatibleAttributedCloserId,
  resolveLegacyCompatibleRecordedByUserId,
} from "../lib/paymentTypes";
import type {
  BillingDmAttribution,
  BillingPaymentDetail,
  BillingPaymentEvent,
  BillingPaymentListRow,
  BillingPaymentRow,
  BillingSlackContributorTimelineEntry,
} from "./types";

const SLACK_CONTRIBUTOR_LIMIT = 25;
const PAYMENT_EVENT_LIMIT = 50;

function tenantOwned<T extends { tenantId: Id<"tenants"> }>(
  doc: T | null,
  tenantId: Id<"tenants">,
): T | null {
  return doc && doc.tenantId === tenantId ? doc : null;
}

function userDisplayName(user: Doc<"users"> | null | undefined) {
  return user?.fullName?.trim() || user?.email || "Unknown user";
}

function nullableUserDisplayName(user: Doc<"users"> | null | undefined) {
  return user ? userDisplayName(user) : null;
}

function slackUserLabel(user: Doc<"slackUsers"> | null | undefined) {
  return (
    user?.displayName?.trim() ||
    user?.realName?.trim() ||
    user?.username?.trim() ||
    user?.slackUserId ||
    null
  );
}

async function resolveSlackUserLabel(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  slackUserId: string,
) {
  const slackUser = await ctx.db
    .query("slackUsers")
    .withIndex("by_tenantId_and_slackUserId", (q) =>
      q.eq("tenantId", tenantId).eq("slackUserId", slackUserId),
    )
    .first();
  return slackUserLabel(slackUser) ?? slackUserId;
}

export type BillingLabels = {
  fullName: string | null;
  email: string | null;
  phone: string | null;
};

const NO_LABELS: BillingLabels = { fullName: null, email: null, phone: null };

// Payments on one deal: the largest deal has a handful.
const DEAL_PAYMENT_LIMIT = 50;

/**
 * The customer name, email and phone billing shows, from the person. A person
 * with no name is named by their email, as the customer copy was.
 */
export function personBillingLabels(person: Doc<"leads"> | null): BillingLabels {
  if (!person) {
    return NO_LABELS;
  }
  return {
    fullName: person.fullName?.trim() || person.email || null,
    email: person.email || null,
    phone: person.phone ?? null,
  };
}

async function firstResolvedMeeting(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  candidates: Array<() => Promise<Id<"meetings"> | undefined>>,
) {
  for (const candidate of candidates) {
    const meetingId = await candidate();
    if (meetingId === undefined) {
      continue;
    }
    const meeting = tenantOwned(await ctx.db.get("meetings", meetingId), tenantId);
    if (meeting) {
      return meeting;
    }
  }
  return null;
}

/** The deal billing shows for a payment: its own, else the one it came from. */
async function resolvePaymentDeal(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  payment: Doc<"paymentRecords">,
) {
  for (const opportunityId of [payment.opportunityId, payment.originatingOpportunityId]) {
    if (opportunityId === undefined) {
      continue;
    }
    const opportunity = tenantOwned(await ctx.db.get("opportunities", opportunityId), tenantId);
    if (opportunity) {
      return opportunity;
    }
  }
  return null;
}

async function resolveDealPerson(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  opportunity: Doc<"opportunities"> | null,
) {
  return opportunity
    ? tenantOwned(await ctx.db.get("leads", opportunity.leadId), tenantId)
    : null;
}

/** The meeting of the earliest payment on the deal that has one. */
async function earliestPaymentMeetingId(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  opportunity: Doc<"opportunities">,
) {
  const payments = await ctx.db
    .query("paymentRecords")
    .withIndex("by_opportunityId_and_recordedAt", (q) =>
      q.eq("opportunityId", opportunity._id),
    )
    .take(DEAL_PAYMENT_LIMIT);
  return payments.find(
    (payment) => payment.tenantId === tenantId && payment.meetingId !== undefined,
  )?.meetingId;
}

/**
 * The meeting billing shows for a payment: its own, else the meeting of the
 * earliest payment on its deal that has one, else the deal's first and then
 * latest meeting (docs/plans/phase-4-customers.md §6.4).
 */
async function resolvePaymentMeeting(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  payment: Doc<"paymentRecords">,
  opportunity: Doc<"opportunities"> | null,
) {
  return await firstResolvedMeeting(ctx, tenantId, [
    async () => payment.meetingId,
    async () =>
      opportunity ? await earliestPaymentMeetingId(ctx, tenantId, opportunity) : undefined,
    async () => opportunity?.firstMeetingId,
    async () => opportunity?.latestMeetingId,
  ]);
}

/** A payment's deal, meeting and person: the customer billing names is the deal's person. */
export async function resolveBillingFromPerson(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  payment: Doc<"paymentRecords">,
) {
  const opportunity = await resolvePaymentDeal(ctx, tenantId, payment);
  const [person, meeting] = await Promise.all([
    resolveDealPerson(ctx, tenantId, opportunity),
    resolvePaymentMeeting(ctx, tenantId, payment, opportunity),
  ]);
  return { person, opportunity, meeting };
}

/**
 * A payment with a meeting and no deal: the meeting's own booking rows. With
 * a deal, `buildOpportunityAttributionSummary` reads the payment's meeting,
 * else the deal's first booking.
 */
async function resolveDirectDmAttribution(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  meeting: Doc<"meetings"> | null,
): Promise<BillingDmAttribution> {
  if (!meeting) {
    return {
      status: "none",
      teamName: null,
      dmCloserName: null,
      dmCloser: null,
      rawSource: null,
      rawMedium: null,
    };
  }

  const dm = await resolveBookingDmAttribution(ctx, {
    tenantId,
    opportunity: null,
    meeting,
  });
  return {
    status: dm.status,
    teamName: dm.team?.displayName ?? null,
    dmCloserName: dm.dmCloser?.displayName ?? null,
    dmCloser: dm.dmCloserIdentity,
    rawSource: meeting.utmParams?.utm_source ?? null,
    rawMedium: meeting.utmParams?.utm_medium ?? null,
  };
}

async function resolveSlackContributorTimeline(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  opportunity: Doc<"opportunities"> | null,
): Promise<BillingSlackContributorTimelineEntry[]> {
  if (!opportunity) {
    return [];
  }

  const events = await ctx.db
    .query("slackQualificationEvents")
    .withIndex("by_tenantId_and_opportunityId_and_submittedAt", (q) =>
      q.eq("tenantId", tenantId).eq("opportunityId", opportunity._id),
    )
    .order("asc")
    .take(SLACK_CONTRIBUTOR_LIMIT);

  if (events.length > 0) {
    return await Promise.all(
      events.map(async (event) => ({
        slackUserId: event.slackUserId,
        label:
          event.fullNameSnapshot.trim() ||
          (await resolveSlackUserLabel(ctx, tenantId, event.slackUserId)),
        identity: slackMemberIdentity(
          await ctx.db
            .query("slackUsers")
            .withIndex("by_tenantId_and_slackUserId", (q) =>
              q.eq("tenantId", tenantId).eq("slackUserId", event.slackUserId),
            )
            .first(),
          `slack:${event.slackUserId}`,
        ),
        submittedAt: event.submittedAt,
        resultKind: event.resultKind,
      })),
    );
  }

  const qualifiedBy = opportunity.qualifiedBy;
  if (!qualifiedBy) {
    return [];
  }

  return [
    {
      slackUserId: qualifiedBy.slackUserId,
      label: await resolveSlackUserLabel(
        ctx,
        tenantId,
        qualifiedBy.slackUserId,
      ),
      identity: slackMemberIdentity(
        await ctx.db
          .query("slackUsers")
          .withIndex("by_tenantId_and_slackUserId", (q) =>
            q
              .eq("tenantId", tenantId)
              .eq("slackUserId", qualifiedBy.slackUserId),
          )
          .first(),
        `slack:${qualifiedBy.slackUserId}`,
      ),
      submittedAt: qualifiedBy.submittedAt,
      resultKind: null,
    },
  ];
}

async function resolveSlackContributorSummary(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  opportunity: Doc<"opportunities"> | null,
) {
  const timeline = await resolveSlackContributorTimeline(ctx, tenantId, opportunity);
  return {
    firstLabel: timeline[0]?.label ?? null,
    latestLabel: timeline.at(-1)?.label ?? null,
    count: timeline.length,
  };
}

async function resolveBillingAttribution(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  payment: Doc<"paymentRecords">,
  opportunity: Doc<"opportunities"> | null,
  meeting: Doc<"meetings"> | null,
) {
  const paymentCloserId = resolveLegacyCompatibleAttributedCloserId(payment);
  const fallbackCloserId =
    paymentCloserId ?? meeting?.assignedCloserId ?? opportunity?.assignedCloserId;
  const [fallbackCloser, payload, directDmAttribution, slackContributorSummary] =
    await Promise.all([
      fallbackCloserId ? ctx.db.get("users", fallbackCloserId) : Promise.resolve(null),
      opportunity
        ? buildOpportunityAttributionSummary(ctx, opportunity, { meeting })
        : Promise.resolve(null),
      opportunity ? Promise.resolve(null) : resolveDirectDmAttribution(ctx, tenantId, meeting),
      resolveSlackContributorSummary(ctx, tenantId, opportunity),
    ]);

  const tenantFallbackCloser = tenantOwned(fallbackCloser, tenantId);
  const phoneCloser =
    tenantFallbackCloser !== null
      ? {
          id: tenantFallbackCloser._id,
          name: userDisplayName(tenantFallbackCloser),
          identity: await userMemberIdentity(ctx, tenantFallbackCloser),
        }
      : payload?.phoneCloser
        ? {
            id: payload.phoneCloser.id,
            name: payload.phoneCloser.name,
            identity: payload.phoneCloser.identity,
          }
        : { id: null, name: null, identity: null };

  return {
    phoneCloser,
    dmAttribution:
      payload?.dmAttribution ??
      directDmAttribution ?? {
        status: "none" as const,
        teamName: null,
        dmCloserName: null,
        dmCloser: null,
        rawSource: null,
        rawMedium: null,
      },
    slackContributorSummary,
  };
}

async function enrichOneBillingPaymentListRow(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  payment: Doc<"paymentRecords">,
): Promise<BillingPaymentListRow> {
  if (payment.tenantId !== tenantId) {
    throw new Error("Cross-tenant payment read blocked.");
  }

  const person = await resolveDealPerson(
    ctx,
    tenantId,
    await resolvePaymentDeal(ctx, tenantId, payment),
  );

  return {
    payment: {
      id: payment._id,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      recordedAt: payment.recordedAt,
      status: payment.status,
      paymentType: payment.paymentType,
      programName: payment.programName,
      hasProofFile: payment.proofFileId !== undefined,
    },
    customer: personBillingLabels(person),
  };
}

async function enrichOneBillingPaymentRow(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  payment: Doc<"paymentRecords">,
): Promise<BillingPaymentRow> {
  if (payment.tenantId !== tenantId) {
    throw new Error("Cross-tenant payment read blocked.");
  }

  const { person, opportunity, meeting } = await resolveBillingFromPerson(
    ctx,
    tenantId,
    payment,
  );

  const recordedByUserId = resolveLegacyCompatibleRecordedByUserId(payment);
  const [enteredBy, reviewer, attribution] = await Promise.all([
    recordedByUserId ? ctx.db.get("users", recordedByUserId) : Promise.resolve(null),
    payment.verifiedByUserId
      ? ctx.db.get("users", payment.verifiedByUserId)
      : Promise.resolve(null),
    resolveBillingAttribution(ctx, tenantId, payment, opportunity, meeting),
  ]);

  const tenantEnteredBy = tenantOwned(enteredBy, tenantId);
  const tenantReviewer = tenantOwned(reviewer, tenantId);

  return {
    payment: {
      id: payment._id,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      recordedAt: payment.recordedAt,
      status: payment.status,
      paymentType: payment.paymentType,
      programId: payment.programId,
      programName: payment.programName,
      origin: payment.origin,
      contextType: payment.contextType,
      referenceCode: payment.referenceCode ?? null,
      note: payment.note ?? null,
      hasProofFile: payment.proofFileId !== undefined,
      fathomLink: payment.fathomLink ?? null,
      commissionable: payment.commissionable,
    },
    customer: { leadId: person?._id ?? null, ...personBillingLabels(person) },
    opportunity: opportunity
      ? {
          id: opportunity._id,
          status: opportunity.status,
          source: opportunity.source ?? null,
        }
      : { id: null, status: null, source: null },
    meeting: meeting
      ? {
          id: meeting._id,
          scheduledAt: meeting.scheduledAt,
          fathomLink: meeting.fathomLink ?? null,
        }
      : { id: null, scheduledAt: null, fathomLink: null },
    enteredBy: {
      id: tenantEnteredBy?._id ?? null,
      name: tenantEnteredBy ? userDisplayName(tenantEnteredBy) : "Missing user",
      identity: tenantEnteredBy
        ? await userMemberIdentity(ctx, tenantEnteredBy)
        : unknownMemberIdentity("Missing user", "unknown"),
    },
    phoneCloser: attribution.phoneCloser,
    dmAttribution: attribution.dmAttribution,
    slackContributorSummary: attribution.slackContributorSummary,
    review: {
      reviewedAt: payment.verifiedAt ?? null,
      reviewerName: nullableUserDisplayName(tenantReviewer),
      reviewer: tenantReviewer
        ? await userMemberIdentity(ctx, tenantReviewer)
        : null,
    },
  };
}

async function loadPaymentEvents(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  paymentRecordId: Id<"paymentRecords">,
): Promise<BillingPaymentEvent[]> {
  const events = await ctx.db
    .query("domainEvents")
    .withIndex("by_tenantId_and_entityType_and_entityId_and_occurredAt", (q) =>
      q
        .eq("tenantId", tenantId)
        .eq("entityType", "payment")
        .eq("entityId", paymentRecordId),
    )
    .order("desc")
    .take(PAYMENT_EVENT_LIMIT);

  const actorIds = [
    ...new Set(
      events
        .map((event) => event.actorUserId)
        .filter((actorUserId): actorUserId is Id<"users"> => actorUserId !== undefined),
    ),
  ];
  const actorPairs = await Promise.all(
    actorIds.map(async (actorId) => [actorId, await ctx.db.get("users", actorId)] as const),
  );
  const actorById = new Map(actorPairs);

  return await Promise.all(events.map(async (event) => {
    const actor = event.actorUserId
      ? tenantOwned(actorById.get(event.actorUserId) ?? null, tenantId)
      : null;
    return {
      id: event._id,
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      source: event.source,
      actorUserId: event.actorUserId ?? null,
      actorName: nullableUserDisplayName(actor),
      actor: actor ? await userMemberIdentity(ctx, actor) : null,
      fromStatus: event.fromStatus ?? null,
      toStatus: event.toStatus ?? null,
      reason: event.reason ?? null,
      metadata: event.metadata ?? null,
    };
  }));
}

export async function enrichBillingPaymentListRows(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  payments: Array<Doc<"paymentRecords">>,
): Promise<BillingPaymentListRow[]> {
  return await Promise.all(
    payments.map((payment) =>
      enrichOneBillingPaymentListRow(ctx, tenantId, payment),
    ),
  );
}

export async function enrichBillingPaymentRows(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  payments: Array<Doc<"paymentRecords">>,
): Promise<BillingPaymentRow[]> {
  return await Promise.all(
    payments.map((payment) => enrichOneBillingPaymentRow(ctx, tenantId, payment)),
  );
}

export async function enrichBillingPaymentDetail(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  payment: Doc<"paymentRecords">,
): Promise<BillingPaymentDetail> {
  const [row, proofUrl, proofMeta, events] = await Promise.all([
    enrichOneBillingPaymentRow(ctx, tenantId, payment),
    payment.proofFileId ? ctx.storage.getUrl(payment.proofFileId) : null,
    payment.proofFileId
      ? ctx.db.system.get("_storage", payment.proofFileId)
      : null,
    loadPaymentEvents(ctx, tenantId, payment._id),
  ]);

  const opportunity = row.opportunity.id
    ? tenantOwned(await ctx.db.get("opportunities", row.opportunity.id), tenantId)
    : null;

  return {
    ...row,
    proof: {
      url: proofUrl,
      contentType: proofMeta?.contentType ?? null,
      size: proofMeta?.size ?? null,
    },
    events,
    slackContributorTimeline: await resolveSlackContributorTimeline(
      ctx,
      tenantId,
      opportunity,
    ),
  };
}
