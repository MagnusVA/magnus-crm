import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { compareMeetings, type KeyedMeeting } from "./clustering";
import {
  answerKey,
  emailKey,
  identifierKey,
  phoneKey,
  socialKey,
  type IdentityKey,
} from "./identityKeys";

// The largest polluted lead holds 134 identifiers, 28 opportunities, 65
// meetings and 434 form answers. A lead past a bound is flagged rather than
// planned from partial data. The totals keep one huge lead inside a
// transaction's read limits.
export const EVIDENCE_LIMITS = {
  identifiers: 500,
  opportunities: 200,
  meetingsPerOpportunity: 200,
  meetings: 300,
  formResponsesPerMeeting: 100,
  formResponses: 1500,
  customers: 10,
  followUps: 200,
  paymentsPerOpportunity: 50,
  slackEvents: 200,
} as const;

export type LeadEvidence = {
  lead: Doc<"leads">;
  identifiers: Doc<"leadIdentifiers">[];
  opportunities: Doc<"opportunities">[];
  /** In booking order. */
  meetings: Doc<"meetings">[];
  formResponses: Doc<"meetingFormResponses">[];
  eventTypeConfigs: Map<Id<"eventTypeConfigs">, Doc<"eventTypeConfigs">>;
  /** Only `ok` snapshots; empty unless loaded with `snapshots`. */
  snapshots: Map<Id<"meetings">, Doc<"leadSplitInviteeSnapshots">>;
  customers: Doc<"customers">[];
  followUps: Doc<"followUps">[];
  payments: Doc<"paymentRecords">[];
  slackEvents: Doc<"slackQualificationEvents">[];
  boundsHit: boolean;
};

type Reader = Pick<QueryCtx, "db">;

async function takeBounded<T>(
  query: { take(n: number): Promise<T[]> },
  limit: number,
): Promise<{ rows: T[]; capped: boolean }> {
  const rows = await query.take(limit + 1);
  return { rows: rows.slice(0, limit), capped: rows.length > limit };
}

/**
 * Reads everything the split plans from for one lead. Discovery skips the
 * snapshots and the rows only `buildPlan` needs (`full: false`).
 */
export async function loadLeadEvidence(
  ctx: Reader,
  lead: Doc<"leads">,
  options: { full: boolean },
): Promise<LeadEvidence> {
  let boundsHit = false;
  const bounded = async <T>(query: { take(n: number): Promise<T[]> }, limit: number) => {
    const result = await takeBounded(query, limit);
    boundsHit ||= result.capped;
    return result.rows;
  };

  const identifiers = await bounded(
    ctx.db.query("leadIdentifiers").withIndex("by_leadId", (q) => q.eq("leadId", lead._id)),
    EVIDENCE_LIMITS.identifiers,
  );
  const opportunities = await bounded(
    ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_leadId", (q) =>
        q.eq("tenantId", lead.tenantId).eq("leadId", lead._id),
      ),
    EVIDENCE_LIMITS.opportunities,
  );

  const meetings: Doc<"meetings">[] = [];
  const formResponses: Doc<"meetingFormResponses">[] = [];
  const payments: Doc<"paymentRecords">[] = [];
  const configIds = new Set<Id<"eventTypeConfigs">>();
  for (const opportunity of opportunities) {
    if (meetings.length >= EVIDENCE_LIMITS.meetings) {
      boundsHit = true;
      break;
    }
    if (opportunity.eventTypeConfigId) configIds.add(opportunity.eventTypeConfigId);
    const opportunityMeetings = await bounded(
      ctx.db
        .query("meetings")
        .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunity._id)),
      EVIDENCE_LIMITS.meetingsPerOpportunity,
    );
    meetings.push(...opportunityMeetings);
    if (meetings.length > EVIDENCE_LIMITS.meetings) {
      boundsHit = true;
      meetings.length = EVIDENCE_LIMITS.meetings;
    }
    if (options.full) {
      payments.push(
        ...(await bounded(
          ctx.db
            .query("paymentRecords")
            .withIndex("by_opportunityId_and_recordedAt", (q) =>
              q.eq("opportunityId", opportunity._id),
            ),
          EVIDENCE_LIMITS.paymentsPerOpportunity,
        )),
      );
    }
  }
  for (const meeting of meetings) {
    if (formResponses.length >= EVIDENCE_LIMITS.formResponses) {
      boundsHit = true;
      break;
    }
    const responses = await bounded(
      ctx.db
        .query("meetingFormResponses")
        .withIndex("by_meetingId", (q) => q.eq("meetingId", meeting._id)),
      EVIDENCE_LIMITS.formResponsesPerMeeting,
    );
    for (const response of responses) {
      if (response.eventTypeConfigId) configIds.add(response.eventTypeConfigId);
    }
    formResponses.push(...responses);
  }
  meetings.sort((a, b) =>
    compareMeetings(
      { ...a, meetingId: a._id },
      { ...b, meetingId: b._id },
    ),
  );

  const eventTypeConfigs = new Map<Id<"eventTypeConfigs">, Doc<"eventTypeConfigs">>();
  for (const configId of configIds) {
    const config = await ctx.db.get("eventTypeConfigs", configId);
    if (config) eventTypeConfigs.set(configId, config);
  }

  const snapshots = new Map<Id<"meetings">, Doc<"leadSplitInviteeSnapshots">>();
  let customers: Doc<"customers">[] = [];
  let followUps: Doc<"followUps">[] = [];
  let slackEvents: Doc<"slackQualificationEvents">[] = [];
  if (options.full) {
    for (const meeting of meetings) {
      const snapshot = await ctx.db
        .query("leadSplitInviteeSnapshots")
        .withIndex("by_meetingId", (q) => q.eq("meetingId", meeting._id))
        .unique();
      if (snapshot?.outcome === "ok") snapshots.set(meeting._id, snapshot);
    }
    customers = await bounded(
      ctx.db
        .query("customers")
        .withIndex("by_tenantId_and_leadId", (q) =>
          q.eq("tenantId", lead.tenantId).eq("leadId", lead._id),
        ),
      EVIDENCE_LIMITS.customers,
    );
    followUps = await bounded(
      ctx.db
        .query("followUps")
        .withIndex("by_tenantId_and_leadId_and_createdAt", (q) =>
          q.eq("tenantId", lead.tenantId).eq("leadId", lead._id),
        ),
      EVIDENCE_LIMITS.followUps,
    );
    slackEvents = await bounded(
      ctx.db
        .query("slackQualificationEvents")
        .withIndex("by_tenantId_and_leadId_and_submittedAt", (q) =>
          q.eq("tenantId", lead.tenantId).eq("leadId", lead._id),
        ),
      EVIDENCE_LIMITS.slackEvents,
    );
  }

  return {
    lead,
    identifiers,
    opportunities,
    meetings,
    formResponses,
    eventTypeConfigs,
    snapshots,
    customers,
    followUps,
    payments,
    slackEvents,
    boundsHit,
  };
}

/** True for an identifier whose value is a placeholder (§5.0 guards). */
export function isPlaceholderIdentifier(identifier: Doc<"leadIdentifiers">): boolean {
  return identifierKey(identifier) === undefined;
}

export function hasPlaceholderKey(evidence: LeadEvidence): boolean {
  return (
    evidence.identifiers.some(isPlaceholderIdentifier) ||
    (evidence.lead.email !== undefined && emailKey(evidence.lead.email) === undefined)
  );
}

export type MeetingKeys = KeyedMeeting & {
  opportunityId: Id<"opportunities">;
  status: Doc<"meetings">["status"];
  /** Every email this meeting sourced as an identifier, placeholders included. */
  sourcedEmails: string[];
  snapshotEmail?: string;
  hasFormResponses: boolean;
};

/**
 * Each meeting's keys (§2 attribution keys): identifiers it sourced, its
 * phone and handle answers, and, with `useSnapshots`, the Calendly invitee.
 */
export function keyMeetings(evidence: LeadEvidence, useSnapshots: boolean): MeetingKeys[] {
  const responsesByMeeting = new Map<Id<"meetings">, Doc<"meetingFormResponses">[]>();
  for (const response of evidence.formResponses) {
    responsesByMeeting.set(response.meetingId, [
      ...(responsesByMeeting.get(response.meetingId) ?? []),
      response,
    ]);
  }
  const opportunityConfig = new Map(
    evidence.opportunities.map((opportunity) => [opportunity._id, opportunity.eventTypeConfigId]),
  );

  return evidence.meetings.map((meeting) => {
    const keys: IdentityKey[] = [];
    const sourcedEmails: string[] = [];
    for (const identifier of evidence.identifiers) {
      if (identifier.sourceMeetingId !== meeting._id) continue;
      if (identifier.type === "email") sourcedEmails.push(identifier.value);
      const key = identifierKey(identifier);
      if (key) keys.push(key);
    }
    for (const response of responsesByMeeting.get(meeting._id) ?? []) {
      const configId = response.eventTypeConfigId ?? opportunityConfig.get(meeting.opportunityId);
      const config = configId ? evidence.eventTypeConfigs.get(configId) : undefined;
      const key = answerKey(
        {
          label: response.questionLabelSnapshot,
          fieldKey: response.fieldKey,
          text: response.answerText,
        },
        config?.customFieldMappings,
      );
      if (key) keys.push(key);
    }
    const snapshot = useSnapshots ? evidence.snapshots.get(meeting._id) : undefined;
    if (snapshot) {
      for (const key of [
        emailKey(snapshot.email),
        phoneKey(snapshot.phone),
        snapshot.social ? socialKey(snapshot.social.platform, snapshot.social.handle) : undefined,
      ]) {
        if (key) keys.push(key);
      }
    }
    const unique = [...new Set(keys)];
    return {
      meetingId: meeting._id,
      opportunityId: meeting.opportunityId,
      scheduledAt: meeting.scheduledAt,
      createdAt: meeting.createdAt,
      status: meeting.status,
      keys: unique,
      name: snapshot?.name?.trim() || undefined,
      sourcedEmails,
      snapshotEmail: snapshot?.email,
      hasFormResponses: (responsesByMeeting.get(meeting._id) ?? []).length > 0,
    };
  });
}
