import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { buildOpportunityAttributionPayload } from "../lib/attribution/detailPayload";
import {
  dmCloserMemberIdentity,
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

async function resolveCustomerFromOpportunity(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  opportunity: Doc<"opportunities"> | null,
) {
  if (!opportunity) {
    return null;
  }
  return await ctx.db
    .query("customers")
    .withIndex("by_tenantId_and_leadId", (q) =>
      q.eq("tenantId", tenantId).eq("leadId", opportunity.leadId),
    )
    .first();
}

async function resolveBillingOpportunity(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  payment: Doc<"paymentRecords">,
  customer: Doc<"customers"> | null,
) {
  const opportunityIds = [
    payment.opportunityId,
    payment.originatingOpportunityId,
    customer?.winningOpportunityId,
  ].filter(
    (opportunityId): opportunityId is Id<"opportunities"> =>
      opportunityId !== undefined,
  );

  for (const opportunityId of opportunityIds) {
    const opportunity = tenantOwned(await ctx.db.get(opportunityId), tenantId);
    if (opportunity) {
      return opportunity;
    }
  }

  return null;
}

async function resolveBillingMeeting(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  payment: Doc<"paymentRecords">,
  customer: Doc<"customers"> | null,
  opportunity: Doc<"opportunities"> | null,
) {
  const meetingIds = [
    payment.meetingId,
    customer?.winningMeetingId,
    opportunity?.firstMeetingId,
    opportunity?.latestMeetingId,
  ].filter(
    (meetingId): meetingId is Id<"meetings"> => meetingId !== undefined,
  );

  for (const meetingId of meetingIds) {
    const meeting = tenantOwned(await ctx.db.get(meetingId), tenantId);
    if (meeting) {
      return meeting;
    }
  }

  return null;
}

async function resolveDirectDmAttribution(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  source:
    | Pick<
        Doc<"meetings">,
        | "attributionResolution"
        | "attributionTeamId"
        | "dmCloserId"
        | "utmParams"
      >
    | null,
): Promise<BillingDmAttribution> {
  if (!source) {
    return {
      status: "none",
      teamName: null,
      dmCloserName: null,
      dmCloser: null,
      rawSource: null,
      rawMedium: null,
    };
  }

  const [team, dmCloser] = await Promise.all([
    source.attributionTeamId
      ? ctx.db.get(source.attributionTeamId)
      : Promise.resolve(null),
    source.dmCloserId ? ctx.db.get(source.dmCloserId) : Promise.resolve(null),
  ]);
  const tenantDmCloser = dmCloser && dmCloser.tenantId === tenantId ? dmCloser : null;
  const linkedUser =
    tenantDmCloser?.userId !== undefined
      ? await ctx.db.get(tenantDmCloser.userId)
      : null;
  const tenantLinkedUser =
    linkedUser && linkedUser.tenantId === tenantId ? linkedUser : null;

  return {
    status: source.attributionResolution ?? "none",
    teamName: team && team.tenantId === tenantId ? team.displayName : null,
    dmCloserName: tenantDmCloser ? tenantDmCloser.displayName : null,
    dmCloser: tenantDmCloser
      ? await dmCloserMemberIdentity(ctx, tenantDmCloser, tenantLinkedUser)
      : null,
    rawSource: source.utmParams?.utm_source ?? null,
    rawMedium: source.utmParams?.utm_medium ?? null,
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
      fallbackCloserId ? ctx.db.get(fallbackCloserId) : Promise.resolve(null),
      opportunity
        ? buildOpportunityAttributionPayload(ctx, opportunity, { meeting })
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

  const directCustomer = payment.customerId
    ? tenantOwned(await ctx.db.get(payment.customerId), tenantId)
    : null;

  let customer = directCustomer;
  if (!customer) {
    const opportunity = await resolveBillingOpportunity(
      ctx,
      tenantId,
      payment,
      null,
    );
    const fallbackCustomer = await resolveCustomerFromOpportunity(
      ctx,
      tenantId,
      opportunity,
    );
    customer = tenantOwned(fallbackCustomer, tenantId);
  }

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
    customer: customer
      ? {
          fullName: customer.fullName || null,
          email: customer.email || null,
          phone: customer.phone ?? null,
        }
      : { fullName: null, email: null, phone: null },
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

  const directCustomer = payment.customerId
    ? tenantOwned(await ctx.db.get(payment.customerId), tenantId)
    : null;
  const opportunity = await resolveBillingOpportunity(
    ctx,
    tenantId,
    payment,
    directCustomer,
  );
  const fallbackCustomer = await resolveCustomerFromOpportunity(
    ctx,
    tenantId,
    opportunity,
  );
  const customer = directCustomer ?? tenantOwned(fallbackCustomer, tenantId);
  const meeting = await resolveBillingMeeting(
    ctx,
    tenantId,
    payment,
    customer,
    opportunity,
  );

  const recordedByUserId = resolveLegacyCompatibleRecordedByUserId(payment);
  const [enteredBy, reviewer, attribution] = await Promise.all([
    recordedByUserId ? ctx.db.get(recordedByUserId) : Promise.resolve(null),
    payment.verifiedByUserId
      ? ctx.db.get(payment.verifiedByUserId)
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
      commissionable: payment.commissionable,
    },
    customer: customer
      ? {
          id: customer._id,
          fullName: customer.fullName || null,
          email: customer.email || null,
          phone: customer.phone ?? null,
        }
      : { id: null, fullName: null, email: null, phone: null },
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
    actorIds.map(async (actorId) => [actorId, await ctx.db.get(actorId)] as const),
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
    ? tenantOwned(await ctx.db.get(row.opportunity.id), tenantId)
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
