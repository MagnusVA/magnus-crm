import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../_generated/server";
import type {
  ActionCtx,
  MutationCtx,
  QueryCtx,
} from "../_generated/server";
import { getString, isRecord } from "../lib/payloadExtraction";
import {
  getLegacyTenantCalendlyConnectionPatch,
  toStoredPatch,
} from "../lib/tenantCalendlyConnection";
import { requireSystemAdminSession } from "../requireSystemAdmin";

const RAW_EVENT_BACKFILL_PAGE_SIZE = 25;
const ACTIVE_OPPORTUNITY_STATUSES = new Set<Doc<"opportunities">["status"]>([
  "scheduled",
  "in_progress",
  "follow_up_scheduled",
  "reschedule_link_sent",
]);

type AdminFunctionCtx = ActionCtx | MutationCtx | QueryCtx;

type RawEventPage = {
  continueCursor: string;
  isDone: boolean;
  page: Array<{
    rawEventId: Id<"rawWebhookEvents">;
  }>;
};

type RawEventBackfillResult = {
  eventTypeConfigIdResolved: boolean;
  eventsProcessed: number;
  responsesCreated: number;
  responsesUpdated: number;
  fieldCatalogCreated: number;
  fieldCatalogUpdated: number;
  questionsSkipped: number;
  status:
    | "processed"
    | "skipped_invalid_json"
    | "skipped_invalid_payload"
    | "skipped_missing_meeting"
    | "skipped_missing_opportunity"
    | "skipped_no_questions";
};

type SeedTenantStatsInternalResult = {
  action: "created" | "updated";
};

type DeduplicateEventTypeConfigsInternalResult = {
  deleted: number;
  fieldCatalogRowsDeleted: number;
  fieldCatalogRowsMerged: number;
  opportunitiesRepointed: number;
  responsesRepointed: number;
};

type UserReferenceIssue = {
  field: string;
  missingUserId: string;
  recordId: string;
  table: string;
};

type TenantCurrencyAudit = {
  counts: Record<string, number>;
  currencies: string[];
  isConsistent: boolean;
  tenantId: string;
};

type Phase6ReadinessReport = {
  followUpsMissingType: number;
  leadsInvalidCustomFields: number;
  leadsMissingStatus: number;
  meetingsMissingAssignedCloserId: number;
  paymentsMissingAmountMinor: number;
  paymentsMissingContextType: number;
  paymentsWithLegacyAmountField: number;
  sampleIds: {
    followUpsMissingType: string[];
    leadsInvalidCustomFields: string[];
    leadsMissingStatus: string[];
    meetingsMissingAssignedCloserId: string[];
    paymentsMissingAmountMinor: string[];
    paymentsMissingContextType: string[];
    paymentsWithLegacyAmountField: string[];
    tenantsMissingCalendlyConnection: string[];
    tenantsWithLegacyOAuthFields: string[];
    usersMissingIsActive: string[];
  };
  tenantsMissingCalendlyConnection: number;
  tenantsWithLegacyOAuthFields: number;
  usersMissingIsActive: number;
};

type TenantScopedTable =
  | "calendlyOrgMembers"
  | "closerUnavailability"
  | "customers"
  | "domainEvents"
  | "eventTypeConfigs"
  | "eventTypeFieldCatalog"
  | "followUps"
  | "leadIdentifiers"
  | "leadMergeHistory"
  | "leads"
  | "meetingFormResponses"
  | "meetingReassignments"
  | "meetings"
  | "opportunities"
  | "paymentRecords"
  | "rawWebhookEvents"
  | "tenantCalendlyConnections"
  | "tenantStats"
  | "users";

const TENANT_SCOPED_TABLES: readonly TenantScopedTable[] = [
  "users",
  "leads",
  "opportunities",
  "meetings",
  "paymentRecords",
  "customers",
  "followUps",
  "eventTypeConfigs",
  "calendlyOrgMembers",
  "rawWebhookEvents",
  "closerUnavailability",
  "meetingReassignments",
  "leadIdentifiers",
  "leadMergeHistory",
  "domainEvents",
  "tenantStats",
  "meetingFormResponses",
  "eventTypeFieldCatalog",
  "tenantCalendlyConnections",
];

async function requireSystemAdmin(
  ctx: AdminFunctionCtx,
): Promise<void> {
  const identity = await ctx.auth.getUserIdentity();
  requireSystemAdminSession(identity);
}

function hasDefinedField(
  row: Record<string, unknown>,
  field: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(row, field) && row[field] !== undefined;
}

function getLegacyNumberField(
  row: Record<string, unknown>,
  field: string,
): number | undefined {
  const value = row[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return value;
}

function addSampleId(sampleIds: string[], id: string): void {
  if (sampleIds.length < 10) {
    sampleIds.push(id);
  }
}

function normalizeFieldKey(question: string): string {
  const normalized = question
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");

  return normalized.length > 0 ? normalized : "unknown";
}

function getUniqueFieldKey(baseKey: string, usedKeys: Set<string>): string {
  if (!usedKeys.has(baseKey)) {
    return baseKey;
  }

  let suffix = 2;
  while (usedKeys.has(`${baseKey}_${suffix}`)) {
    suffix += 1;
  }

  return `${baseKey}_${suffix}`;
}

function extractQuestionsAndAnswers(
  value: unknown,
): Array<{ answer: string; question: string }> {
  if (!Array.isArray(value)) {
    return [];
  }

  const entries: Array<{ answer: string; question: string }> = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }

    const question = getString(item, "question")?.trim();
    const answer = getString(item, "answer")?.trim();
    if (!question || !answer) {
      continue;
    }

    entries.push({ answer, question });
  }

  return entries;
}

function mergePaymentLinks(
  canonical: Doc<"eventTypeConfigs">["paymentLinks"],
  duplicate: Doc<"eventTypeConfigs">["paymentLinks"],
): Doc<"eventTypeConfigs">["paymentLinks"] {
  if (!canonical?.length) {
    return duplicate ?? canonical;
  }
  if (!duplicate?.length) {
    return canonical;
  }

  const seen = new Set(
    canonical.map((link) => `${link.provider}|${link.label}|${link.url}`),
  );
  const merged = [...canonical];

  for (const link of duplicate) {
    const key = `${link.provider}|${link.label}|${link.url}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(link);
  }

  return merged;
}

function mergeKnownCustomFieldKeys(
  canonical: string[] | undefined,
  duplicate: string[] | undefined,
): string[] | undefined {
  if (!canonical?.length && !duplicate?.length) {
    return undefined;
  }

  const merged = new Set<string>(canonical ?? []);
  for (const key of duplicate ?? []) {
    merged.add(key);
  }

  return [...merged];
}

function getCanonicalEventTypeConfig(
  configs: Doc<"eventTypeConfigs">[],
): Doc<"eventTypeConfigs"> | null {
  if (configs.length === 0) {
    return null;
  }

  return configs.reduce((best, current) =>
    current.createdAt < best.createdAt ? current : best,
  );
}

function addMissingUserIssue(
  issues: UserReferenceIssue[],
  userIds: Set<Id<"users">>,
  args: {
    field: string;
    recordId: string;
    table: string;
    userId: Id<"users"> | undefined;
  },
): void {
  if (!args.userId || userIds.has(args.userId)) {
    return;
  }

  issues.push({
    table: args.table,
    field: args.field,
    recordId: args.recordId,
    missingUserId: args.userId,
  });
}

async function resolveCanonicalEventTypeConfigId(
  ctx: MutationCtx,
  args: {
    payload: Record<string, unknown>;
    tenantId: Id<"tenants">;
    opportunity: Doc<"opportunities">;
  },
): Promise<Id<"eventTypeConfigs"> | undefined> {
  const scheduledEvent = isRecord(args.payload.scheduled_event)
    ? args.payload.scheduled_event
    : undefined;
  const eventTypeUri = scheduledEvent
    ? getString(scheduledEvent, "event_type")
    : undefined;

  let candidateUri = eventTypeUri;
  if (!candidateUri && args.opportunity.eventTypeConfigId) {
    const existingConfig = await ctx.db.get(args.opportunity.eventTypeConfigId);
    candidateUri = existingConfig?.calendlyEventTypeUri;
  }

  if (!candidateUri) {
    return args.opportunity.eventTypeConfigId ?? undefined;
  }

  const candidates = await ctx.db
    .query("eventTypeConfigs")
    .withIndex("by_tenantId_and_calendlyEventTypeUri", (q) =>
      q
        .eq("tenantId", args.tenantId)
        .eq("calendlyEventTypeUri", candidateUri),
    )
    .take(8);

  return getCanonicalEventTypeConfig(candidates)?._id;
}

async function upsertFieldCatalogEntry(
  ctx: MutationCtx,
  args: {
    eventTypeConfigId: Id<"eventTypeConfigs">;
    fieldKey: string;
    questionLabel: string;
    seenAt: number;
    tenantId: Id<"tenants">;
  },
): Promise<{
  action: "created" | "updated" | "unchanged";
  fieldCatalogId: Id<"eventTypeFieldCatalog">;
}> {
  const existingEntries = await ctx.db
    .query("eventTypeFieldCatalog")
    .withIndex("by_tenantId_and_eventTypeConfigId", (q) =>
      q
        .eq("tenantId", args.tenantId)
        .eq("eventTypeConfigId", args.eventTypeConfigId),
    )
    .collect();
  const existingEntry =
    existingEntries.find((entry) => entry.fieldKey === args.fieldKey) ?? null;

  if (existingEntry) {
    const patch: Partial<Doc<"eventTypeFieldCatalog">> = {};
    if (args.seenAt > existingEntry.lastSeenAt) {
      patch.lastSeenAt = args.seenAt;
      patch.currentLabel = args.questionLabel;
    } else if (existingEntry.currentLabel !== args.questionLabel) {
      patch.currentLabel = args.questionLabel;
    }

    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(existingEntry._id, patch);
      return {
        action: "updated",
        fieldCatalogId: existingEntry._id,
      };
    }

    return {
      action: "unchanged",
      fieldCatalogId: existingEntry._id,
    };
  }

  const fieldCatalogId = await ctx.db.insert("eventTypeFieldCatalog", {
    tenantId: args.tenantId,
    eventTypeConfigId: args.eventTypeConfigId,
    fieldKey: args.fieldKey,
    currentLabel: args.questionLabel,
    firstSeenAt: args.seenAt,
    lastSeenAt: args.seenAt,
  });

  return {
    action: "created",
    fieldCatalogId,
  };
}

export const listInviteeCreatedRawEventIdsPage = internalQuery({
  args: {
    paginationOpts: paginationOptsValidator,
    tenantId: v.id("tenants"),
  },
  handler: async (ctx, { paginationOpts, tenantId }): Promise<RawEventPage> => {
    const result = await ctx.db
      .query("rawWebhookEvents")
      .withIndex("by_tenantId_and_eventType", (q) =>
        q.eq("tenantId", tenantId).eq("eventType", "invitee.created"),
      )
      .order("desc")
      .paginate(paginationOpts);

    return {
      page: result.page.map((rawEvent) => ({ rawEventId: rawEvent._id })),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

export const getActiveTenantIds = internalQuery({
  args: {},
  handler: async (ctx): Promise<Id<"tenants">[]> => {
    const tenants = await ctx.db
      .query("tenants")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .collect();

    return tenants.map((tenant) => tenant._id);
  },
});

export const getAllTenantIds = internalQuery({
  args: {},
  handler: async (ctx): Promise<Id<"tenants">[]> => {
    const tenantIds: Id<"tenants">[] = [];
    for await (const tenant of ctx.db.query("tenants")) {
      tenantIds.push(tenant._id);
    }
    return tenantIds;
  },
});

export const backfillMeetingFormResponsesForRawEvent = internalMutation({
  args: { rawEventId: v.id("rawWebhookEvents") },
  handler: async (ctx, { rawEventId }): Promise<RawEventBackfillResult> => {
    const rawEvent = await ctx.db.get(rawEventId);
    if (!rawEvent) {
      return {
        status: "skipped_missing_meeting",
        eventsProcessed: 0,
        responsesCreated: 0,
        responsesUpdated: 0,
        fieldCatalogCreated: 0,
        fieldCatalogUpdated: 0,
        questionsSkipped: 0,
        eventTypeConfigIdResolved: false,
      };
    }

    let envelope: unknown;
    try {
      envelope = JSON.parse(rawEvent.payload);
    } catch (error) {
      console.error("[Migration:2A] Failed to parse raw webhook payload", {
        rawEventId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        status: "skipped_invalid_json",
        eventsProcessed: 0,
        responsesCreated: 0,
        responsesUpdated: 0,
        fieldCatalogCreated: 0,
        fieldCatalogUpdated: 0,
        questionsSkipped: 0,
        eventTypeConfigIdResolved: false,
      };
    }

    const payload = isRecord(envelope) && isRecord(envelope.payload)
      ? envelope.payload
      : null;
    if (!payload) {
      return {
        status: "skipped_invalid_payload",
        eventsProcessed: 0,
        responsesCreated: 0,
        responsesUpdated: 0,
        fieldCatalogCreated: 0,
        fieldCatalogUpdated: 0,
        questionsSkipped: 0,
        eventTypeConfigIdResolved: false,
      };
    }

    const questionsAndAnswers = extractQuestionsAndAnswers(
      payload.questions_and_answers,
    );
    if (questionsAndAnswers.length === 0) {
      return {
        status: "skipped_no_questions",
        eventsProcessed: 0,
        responsesCreated: 0,
        responsesUpdated: 0,
        fieldCatalogCreated: 0,
        fieldCatalogUpdated: 0,
        questionsSkipped: 0,
        eventTypeConfigIdResolved: false,
      };
    }

    const meeting = await ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_calendlyEventUri", (q) =>
        q
          .eq("tenantId", rawEvent.tenantId)
          .eq("calendlyEventUri", rawEvent.calendlyEventUri),
      )
      .first();
    if (!meeting) {
      return {
        status: "skipped_missing_meeting",
        eventsProcessed: 0,
        responsesCreated: 0,
        responsesUpdated: 0,
        fieldCatalogCreated: 0,
        fieldCatalogUpdated: 0,
        questionsSkipped: 0,
        eventTypeConfigIdResolved: false,
      };
    }

    const opportunity = await ctx.db.get(meeting.opportunityId);
    if (!opportunity || opportunity.tenantId !== rawEvent.tenantId) {
      return {
        status: "skipped_missing_opportunity",
        eventsProcessed: 0,
        responsesCreated: 0,
        responsesUpdated: 0,
        fieldCatalogCreated: 0,
        fieldCatalogUpdated: 0,
        questionsSkipped: 0,
        eventTypeConfigIdResolved: false,
      };
    }

    const eventTypeConfigId = await resolveCanonicalEventTypeConfigId(ctx, {
      tenantId: rawEvent.tenantId,
      opportunity,
      payload,
    });

    const existingResponses = await ctx.db
      .query("meetingFormResponses")
      .withIndex("by_meetingId", (q) => q.eq("meetingId", meeting._id))
      .collect();

    const responseByQuestion = new Map<string, Doc<"meetingFormResponses">>();
    const usedFieldKeys = new Set<string>();
    for (const response of existingResponses) {
      responseByQuestion.set(response.questionLabelSnapshot, response);
      usedFieldKeys.add(response.fieldKey);
    }

    let responsesCreated = 0;
    let responsesUpdated = 0;
    let fieldCatalogCreated = 0;
    let fieldCatalogUpdated = 0;
    let questionsSkipped = 0;

    for (const qa of questionsAndAnswers) {
      const existingResponse = responseByQuestion.get(qa.question) ?? null;
      const baseFieldKey = normalizeFieldKey(qa.question);
      const fieldKey = existingResponse
        ? existingResponse.fieldKey
        : getUniqueFieldKey(baseFieldKey, usedFieldKeys);

      let fieldCatalogId: Id<"eventTypeFieldCatalog"> | undefined;
      if (eventTypeConfigId) {
        const fieldCatalogResult = await upsertFieldCatalogEntry(ctx, {
          tenantId: rawEvent.tenantId,
          eventTypeConfigId,
          fieldKey,
          questionLabel: qa.question,
          seenAt: rawEvent.receivedAt,
        });
        fieldCatalogId = fieldCatalogResult.fieldCatalogId;
        if (fieldCatalogResult.action === "created") {
          fieldCatalogCreated += 1;
        } else if (fieldCatalogResult.action === "updated") {
          fieldCatalogUpdated += 1;
        }
      }

      if (existingResponse) {
        const patch: Partial<Doc<"meetingFormResponses">> = {};
        if (!existingResponse.eventTypeConfigId && eventTypeConfigId) {
          patch.eventTypeConfigId = eventTypeConfigId;
        }
        if (!existingResponse.fieldCatalogId && fieldCatalogId) {
          patch.fieldCatalogId = fieldCatalogId;
        }

        if (Object.keys(patch).length > 0) {
          await ctx.db.patch(existingResponse._id, patch);
          responsesUpdated += 1;
        } else {
          questionsSkipped += 1;
        }
        continue;
      }

      usedFieldKeys.add(fieldKey);
      const responseId = await ctx.db.insert("meetingFormResponses", {
        tenantId: rawEvent.tenantId,
        meetingId: meeting._id,
        opportunityId: opportunity._id,
        leadId: opportunity.leadId,
        eventTypeConfigId,
        fieldCatalogId,
        fieldKey,
        questionLabelSnapshot: qa.question,
        answerText: qa.answer,
        capturedAt: rawEvent.receivedAt,
      });
      responsesCreated += 1;
      responseByQuestion.set(qa.question, {
        _id: responseId,
        _creationTime: rawEvent.receivedAt,
        tenantId: rawEvent.tenantId,
        meetingId: meeting._id,
        opportunityId: opportunity._id,
        leadId: opportunity.leadId,
        eventTypeConfigId,
        fieldCatalogId,
        fieldKey,
        questionLabelSnapshot: qa.question,
        answerText: qa.answer,
        capturedAt: rawEvent.receivedAt,
      });
    }

    return {
      status: "processed",
      eventsProcessed: 1,
      responsesCreated,
      responsesUpdated,
      fieldCatalogCreated,
      fieldCatalogUpdated,
      questionsSkipped,
      eventTypeConfigIdResolved: !!eventTypeConfigId,
    };
  },
});

export const seedTenantStatsInternal = internalMutation({
  args: { tenantId: v.id("tenants") },
  handler: async (
    ctx,
    { tenantId },
  ): Promise<SeedTenantStatsInternalResult> => {
    const users = await ctx.db
      .query("users")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .collect();
    const activeUsers = users.filter((user) => user.isActive);
    const closers = activeUsers.filter((user) => user.role === "closer");

    const opportunities = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .collect();
    const activeOpportunities = opportunities.filter((opportunity) =>
      ACTIVE_OPPORTUNITY_STATUSES.has(opportunity.status),
    );
    const wonDeals = opportunities.filter(
      (opportunity) => opportunity.status === "payment_received",
    );
    const lostDeals = opportunities.filter(
      (opportunity) => opportunity.status === "lost",
    );

    const payments = await ctx.db
      .query("paymentRecords")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .collect();
    const nonDisputedPayments = payments.filter(
      (payment) => payment.status !== "disputed",
    );
    const totalRevenueMinor = nonDisputedPayments.reduce(
      (sum, payment) => sum + payment.amountMinor,
      0,
    );

    const leads = await ctx.db
      .query("leads")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .collect();
    const activeLeads = leads.filter((lead) => lead.status === "active");

    const customers = await ctx.db
      .query("customers")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .collect();

    const payload = {
      totalTeamMembers: activeUsers.length,
      totalClosers: closers.length,
      totalOpportunities: opportunities.length,
      activeOpportunities: activeOpportunities.length,
      wonDeals: wonDeals.length,
      lostDeals: lostDeals.length,
      totalRevenueMinor,
      totalPaymentRecords: nonDisputedPayments.length,
      totalLeads: activeLeads.length,
      totalCustomers: customers.length,
      lastUpdatedAt: Date.now(),
    };

    const existingStats = await ctx.db
      .query("tenantStats")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .first();

    if (existingStats) {
      await ctx.db.patch(existingStats._id, payload);
      return { action: "updated" };
    }

    await ctx.db.insert("tenantStats", {
      tenantId,
      ...payload,
    });

    return { action: "created" };
  },
});

export const deduplicateEventTypeConfigsInternal = internalMutation({
  args: { tenantId: v.id("tenants") },
  handler: async (
    ctx,
    { tenantId },
  ): Promise<DeduplicateEventTypeConfigsInternalResult> => {
    const configs = await ctx.db
      .query("eventTypeConfigs")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .collect();

    const groupedConfigs = new Map<string, Doc<"eventTypeConfigs">[]>();
    for (const config of configs) {
      const group = groupedConfigs.get(config.calendlyEventTypeUri) ?? [];
      group.push(config);
      groupedConfigs.set(config.calendlyEventTypeUri, group);
    }

    let deleted = 0;
    let fieldCatalogRowsDeleted = 0;
    let fieldCatalogRowsMerged = 0;
    let opportunitiesRepointed = 0;
    let responsesRepointed = 0;

    for (const [eventTypeUri, group] of groupedConfigs) {
      if (group.length <= 1) {
        continue;
      }

      const canonicalConfig = getCanonicalEventTypeConfig(group);
      if (!canonicalConfig) {
        continue;
      }

      const duplicates = group.filter(
        (config) => config._id !== canonicalConfig._id,
      );

      const mergedKnownCustomFieldKeys = mergeKnownCustomFieldKeys(
        canonicalConfig.knownCustomFieldKeys,
        duplicates.flatMap((config) => config.knownCustomFieldKeys ?? []),
      );
      const mergedPaymentLinks = duplicates.reduce(
        (paymentLinks, duplicate) =>
          mergePaymentLinks(paymentLinks, duplicate.paymentLinks),
        canonicalConfig.paymentLinks,
      );
      const mergedCustomFieldMappings =
        canonicalConfig.customFieldMappings ??
        duplicates.find((config) => config.customFieldMappings)?.customFieldMappings;

      const canonicalPatch: Partial<Doc<"eventTypeConfigs">> = {};
      if (
        JSON.stringify(mergedKnownCustomFieldKeys ?? []) !==
        JSON.stringify(canonicalConfig.knownCustomFieldKeys ?? [])
      ) {
        canonicalPatch.knownCustomFieldKeys = mergedKnownCustomFieldKeys;
      }
      if (
        JSON.stringify(mergedPaymentLinks ?? []) !==
        JSON.stringify(canonicalConfig.paymentLinks ?? [])
      ) {
        canonicalPatch.paymentLinks = mergedPaymentLinks;
      }
      if (
        !canonicalConfig.customFieldMappings &&
        mergedCustomFieldMappings
      ) {
        canonicalPatch.customFieldMappings = mergedCustomFieldMappings;
      }

      if (Object.keys(canonicalPatch).length > 0) {
        await ctx.db.patch(canonicalConfig._id, canonicalPatch);
      }

      const canonicalFieldCatalogRows = await ctx.db
        .query("eventTypeFieldCatalog")
        .withIndex("by_tenantId_and_eventTypeConfigId", (q) =>
          q
            .eq("tenantId", tenantId)
            .eq("eventTypeConfigId", canonicalConfig._id),
        )
        .collect();
      const canonicalFieldCatalogByKey = new Map<
        string,
        Doc<"eventTypeFieldCatalog">
      >(canonicalFieldCatalogRows.map((row) => [row.fieldKey, row]));

      for (const duplicate of duplicates) {
        const fieldCatalogRemap = new Map<
          Id<"eventTypeFieldCatalog">,
          Id<"eventTypeFieldCatalog">
        >();
        const duplicateFieldCatalogRows = await ctx.db
          .query("eventTypeFieldCatalog")
          .withIndex("by_tenantId_and_eventTypeConfigId", (q) =>
            q
              .eq("tenantId", tenantId)
              .eq("eventTypeConfigId", duplicate._id),
          )
          .collect();

        for (const duplicateFieldCatalog of duplicateFieldCatalogRows) {
          const existingCanonicalFieldCatalog =
            canonicalFieldCatalogByKey.get(duplicateFieldCatalog.fieldKey) ?? null;

          if (existingCanonicalFieldCatalog) {
            const patch: Partial<Doc<"eventTypeFieldCatalog">> = {};
            if (duplicateFieldCatalog.firstSeenAt < existingCanonicalFieldCatalog.firstSeenAt) {
              patch.firstSeenAt = duplicateFieldCatalog.firstSeenAt;
            }
            if (duplicateFieldCatalog.lastSeenAt > existingCanonicalFieldCatalog.lastSeenAt) {
              patch.lastSeenAt = duplicateFieldCatalog.lastSeenAt;
              patch.currentLabel = duplicateFieldCatalog.currentLabel;
            }
            if (!existingCanonicalFieldCatalog.valueType && duplicateFieldCatalog.valueType) {
              patch.valueType = duplicateFieldCatalog.valueType;
            }

            if (Object.keys(patch).length > 0) {
              await ctx.db.patch(existingCanonicalFieldCatalog._id, patch);
              fieldCatalogRowsMerged += 1;
            }

            fieldCatalogRemap.set(
              duplicateFieldCatalog._id,
              existingCanonicalFieldCatalog._id,
            );
            continue;
          }

          const newCanonicalFieldCatalogId = await ctx.db.insert(
            "eventTypeFieldCatalog",
            {
              tenantId,
              eventTypeConfigId: canonicalConfig._id,
              fieldKey: duplicateFieldCatalog.fieldKey,
              currentLabel: duplicateFieldCatalog.currentLabel,
              firstSeenAt: duplicateFieldCatalog.firstSeenAt,
              lastSeenAt: duplicateFieldCatalog.lastSeenAt,
              valueType: duplicateFieldCatalog.valueType,
            },
          );

          const movedFieldCatalog = await ctx.db.get(newCanonicalFieldCatalogId);
          if (movedFieldCatalog) {
            canonicalFieldCatalogByKey.set(
              movedFieldCatalog.fieldKey,
              movedFieldCatalog,
            );
          }

          fieldCatalogRemap.set(
            duplicateFieldCatalog._id,
            newCanonicalFieldCatalogId,
          );
          fieldCatalogRowsMerged += 1;
        }

        const opportunities = await ctx.db
          .query("opportunities")
          .withIndex("by_tenantId_and_eventTypeConfigId", (q) =>
            q.eq("tenantId", tenantId).eq("eventTypeConfigId", duplicate._id),
          )
          .collect();
        for (const opportunity of opportunities) {
          await ctx.db.patch(opportunity._id, {
            eventTypeConfigId: canonicalConfig._id,
          });
          opportunitiesRepointed += 1;
        }

        const responses = await ctx.db
          .query("meetingFormResponses")
          .withIndex("by_tenantId_and_eventTypeConfigId", (q) =>
            q.eq("tenantId", tenantId).eq("eventTypeConfigId", duplicate._id),
          )
          .collect();
        for (const response of responses) {
          const patch: Partial<Doc<"meetingFormResponses">> = {
            eventTypeConfigId: canonicalConfig._id,
          };

          if (response.fieldCatalogId) {
            const remappedFieldCatalogId =
              fieldCatalogRemap.get(response.fieldCatalogId) ??
              canonicalFieldCatalogByKey.get(response.fieldKey)?._id;
            if (remappedFieldCatalogId) {
              patch.fieldCatalogId = remappedFieldCatalogId;
            }
          } else {
            const canonicalFieldCatalogId =
              canonicalFieldCatalogByKey.get(response.fieldKey)?._id;
            if (canonicalFieldCatalogId) {
              patch.fieldCatalogId = canonicalFieldCatalogId;
            }
          }

          await ctx.db.patch(response._id, patch);
          responsesRepointed += 1;
        }

        for (const duplicateFieldCatalog of duplicateFieldCatalogRows) {
          await ctx.db.delete(duplicateFieldCatalog._id);
          fieldCatalogRowsDeleted += 1;
        }

        await ctx.db.delete(duplicate._id);
        deleted += 1;
      }

      console.log("[Migration:2E] Deduplicated eventTypeConfig group", {
        tenantId,
        eventTypeUri,
        canonicalConfigId: canonicalConfig._id,
        duplicatesDeleted: duplicates.length,
      });
    }

    return {
      deleted,
      fieldCatalogRowsDeleted,
      fieldCatalogRowsMerged,
      opportunitiesRepointed,
      responsesRepointed,
    };
  },
});

export const backfillMeetingFormResponses = action({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    await requireSystemAdmin(ctx);

    let cursor: string | null = null;
    let eventsScanned = 0;
    let eventsProcessed = 0;
    let eventsSkippedInvalidJson = 0;
    let eventsSkippedInvalidPayload = 0;
    let eventsSkippedMissingMeeting = 0;
    let eventsSkippedMissingOpportunity = 0;
    let eventsSkippedNoQuestions = 0;
    let responsesCreated = 0;
    let responsesUpdated = 0;
    let fieldCatalogCreated = 0;
    let fieldCatalogUpdated = 0;
    let eventTypeConfigResolutions = 0;

    while (true) {
      const page: RawEventPage = await ctx.runQuery(
        internal.admin.migrations.listInviteeCreatedRawEventIdsPage,
        {
          tenantId,
          paginationOpts: {
            cursor,
            numItems: RAW_EVENT_BACKFILL_PAGE_SIZE,
          },
        },
      );

      for (const row of page.page) {
        eventsScanned += 1;
        const result: RawEventBackfillResult = await ctx.runMutation(
          internal.admin.migrations.backfillMeetingFormResponsesForRawEvent,
          { rawEventId: row.rawEventId },
        );

        eventsProcessed += result.eventsProcessed;
        responsesCreated += result.responsesCreated;
        responsesUpdated += result.responsesUpdated;
        fieldCatalogCreated += result.fieldCatalogCreated;
        fieldCatalogUpdated += result.fieldCatalogUpdated;
        if (result.eventTypeConfigIdResolved) {
          eventTypeConfigResolutions += 1;
        }

        switch (result.status) {
          case "skipped_invalid_json":
            eventsSkippedInvalidJson += 1;
            break;
          case "skipped_invalid_payload":
            eventsSkippedInvalidPayload += 1;
            break;
          case "skipped_missing_meeting":
            eventsSkippedMissingMeeting += 1;
            break;
          case "skipped_missing_opportunity":
            eventsSkippedMissingOpportunity += 1;
            break;
          case "skipped_no_questions":
            eventsSkippedNoQuestions += 1;
            break;
          case "processed":
            break;
        }
      }

      if (page.isDone) {
        break;
      }

      cursor = page.continueCursor;
    }

    console.log("[Migration:2A] Meeting form response backfill complete", {
      tenantId,
      eventsScanned,
      eventsProcessed,
      eventsSkippedInvalidJson,
      eventsSkippedInvalidPayload,
      eventsSkippedMissingMeeting,
      eventsSkippedMissingOpportunity,
      eventsSkippedNoQuestions,
      responsesCreated,
      responsesUpdated,
      fieldCatalogCreated,
      fieldCatalogUpdated,
      eventTypeConfigResolutions,
    });

    return {
      tenantId,
      eventsScanned,
      eventsProcessed,
      eventsSkippedInvalidJson,
      eventsSkippedInvalidPayload,
      eventsSkippedMissingMeeting,
      eventsSkippedMissingOpportunity,
      eventsSkippedNoQuestions,
      responsesCreated,
      responsesUpdated,
      fieldCatalogCreated,
      fieldCatalogUpdated,
      eventTypeConfigResolutions,
    };
  },
});

function collectCandidateCloser(
  candidateScores: Map<
    Id<"users">,
    { score: number; sources: Set<string> }
  >,
  closerId: Id<"users"> | undefined,
  source: string,
  score: number,
): void {
  if (!closerId) {
    return;
  }

  const existing = candidateScores.get(closerId) ?? {
    score: 0,
    sources: new Set<string>(),
  };
  existing.score += score;
  existing.sources.add(source);
  candidateScores.set(closerId, existing);
}

async function inferOpportunityAssignedCloserId(
  ctx: MutationCtx,
  opportunity: Doc<"opportunities">,
): Promise<{
  assignedCloserId: Id<"users"> | null;
  reason:
    | "already_set"
    | "host_calendly_user"
    | "meeting_history"
    | "follow_up_history"
    | "payment_history"
    | "ambiguous"
    | "not_found";
}> {
  if (opportunity.assignedCloserId) {
    return {
      assignedCloserId: opportunity.assignedCloserId,
      reason: "already_set",
    };
  }

  const candidateScores = new Map<
    Id<"users">,
    { score: number; sources: Set<string> }
  >();

  if (opportunity.hostCalendlyUserUri) {
    const hostUser = await ctx.db
      .query("users")
      .withIndex("by_tenantId_and_calendlyUserUri", (q) =>
        q
          .eq("tenantId", opportunity.tenantId)
          .eq("calendlyUserUri", opportunity.hostCalendlyUserUri!),
      )
      .first();
    collectCandidateCloser(
      candidateScores,
      hostUser?._id,
      "host_calendly_user",
      100,
    );
  }

  const relatedMeetings = await ctx.db
    .query("meetings")
    .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunity._id))
    .collect();
  for (const meeting of relatedMeetings) {
    collectCandidateCloser(
      candidateScores,
      meeting.assignedCloserId,
      "meeting_history",
      40,
    );
  }

  const followUps = await ctx.db
    .query("followUps")
    .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunity._id))
    .collect();
  for (const followUp of followUps) {
    collectCandidateCloser(
      candidateScores,
      followUp.closerId,
      "follow_up_history",
      20,
    );
  }

  const payments = await ctx.db
    .query("paymentRecords")
    .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunity._id))
    .collect();
  for (const payment of payments) {
    collectCandidateCloser(
      candidateScores,
      payment.closerId,
      "payment_history",
      10,
    );
  }

  if (candidateScores.size === 0) {
    return { assignedCloserId: null, reason: "not_found" };
  }

  const ranked = [...candidateScores.entries()].sort((a, b) => {
    if (b[1].score !== a[1].score) {
      return b[1].score - a[1].score;
    }
    return a[0].localeCompare(b[0]);
  });

  const [bestCloserId, bestMeta] = ranked[0];
  const secondBestScore = ranked[1]?.[1].score ?? -1;
  if (bestMeta.score === secondBestScore) {
    return { assignedCloserId: null, reason: "ambiguous" };
  }

  const primarySource = [...bestMeta.sources][0] ?? "meeting_history";
  switch (primarySource) {
    case "host_calendly_user":
      return { assignedCloserId: bestCloserId, reason: "host_calendly_user" };
    case "follow_up_history":
      return { assignedCloserId: bestCloserId, reason: "follow_up_history" };
    case "payment_history":
      return { assignedCloserId: bestCloserId, reason: "payment_history" };
    default:
      return { assignedCloserId: bestCloserId, reason: "meeting_history" };
  }
}

export const backfillLeadStatus = mutation({
  args: {},
  handler: async (ctx) => {
    await requireSystemAdmin(ctx);

    const leads = await ctx.db.query("leads").collect();
    let updated = 0;
    for (const lead of leads) {
      if (lead.status !== undefined) {
        continue;
      }

      await ctx.db.patch(lead._id, { status: "active" });
      updated += 1;
    }

    console.log("[Migration:2B] Lead status backfill complete", {
      updated,
      total: leads.length,
    });

    return { updated, total: leads.length };
  },
});

export const backfillUserIsActive = mutation({
  args: {},
  handler: async (ctx) => {
    await requireSystemAdmin(ctx);

    const users = await ctx.db.query("users").collect();
    let updated = 0;
    for (const user of users) {
      if (user.isActive !== undefined) {
        continue;
      }

      await ctx.db.patch(user._id, { isActive: true });
      updated += 1;
    }

    console.log("[Migration:2B] User isActive backfill complete", {
      updated,
      total: users.length,
    });

    return { updated, total: users.length };
  },
});

export const backfillPaymentAmountMinor = mutation({
  args: {},
  handler: async (ctx) => {
    await requireSystemAdmin(ctx);

    const payments = await ctx.db.query("paymentRecords").collect();
    let updated = 0;
    let skippedMissingLegacyAmount = 0;
    const sampleIdsMissingLegacyAmount: string[] = [];

    for (const payment of payments) {
      if (payment.amountMinor !== undefined) {
        continue;
      }

      const legacyAmount = getLegacyNumberField(
        payment as Record<string, unknown>,
        "amount",
      );
      if (legacyAmount === undefined) {
        skippedMissingLegacyAmount += 1;
        addSampleId(sampleIdsMissingLegacyAmount, payment._id);
        continue;
      }

      await ctx.db.patch(payment._id, {
        amountMinor: Math.round(legacyAmount * 100),
      });
      updated += 1;
    }

    console.log("[Migration:2B] Payment amountMinor backfill complete", {
      updated,
      skippedMissingLegacyAmount,
      sampleIdsMissingLegacyAmount,
      total: payments.length,
    });

    return {
      updated,
      skippedMissingLegacyAmount,
      sampleIdsMissingLegacyAmount,
      total: payments.length,
    };
  },
});

export const backfillPaymentContextType = mutation({
  args: {},
  handler: async (ctx) => {
    await requireSystemAdmin(ctx);

    const payments = await ctx.db.query("paymentRecords").collect();
    let updated = 0;
    for (const payment of payments) {
      if (payment.contextType !== undefined) {
        continue;
      }

      await ctx.db.patch(payment._id, {
        contextType: payment.opportunityId ? "opportunity" : "customer",
      });
      updated += 1;
    }

    console.log("[Migration:2B] Payment contextType backfill complete", {
      updated,
      total: payments.length,
    });

    return { updated, total: payments.length };
  },
});

export const backfillFollowUpType = mutation({
  args: {},
  handler: async (ctx) => {
    await requireSystemAdmin(ctx);

    const followUps = await ctx.db.query("followUps").collect();
    let updated = 0;
    for (const followUp of followUps) {
      if (followUp.type !== undefined) {
        continue;
      }

      await ctx.db.patch(followUp._id, {
        type: followUp.schedulingLinkUrl
          ? "scheduling_link"
          : "manual_reminder",
      });
      updated += 1;
    }

    console.log("[Migration:2B] Follow-up type backfill complete", {
      updated,
      total: followUps.length,
    });

    return { updated, total: followUps.length };
  },
});

export const backfillMeetingCloserId = mutation({
  args: {},
  handler: async (ctx) => {
    await requireSystemAdmin(ctx);

    const meetings = await ctx.db.query("meetings").collect();
    let updated = 0;
    let opportunitiesPatched = 0;
    const inferredByReason: Record<string, number> = {};
    const skippedMeetings: Array<{
      meetingId: string;
      opportunityId: string;
      reason: string;
    }> = [];

    const addSkippedMeeting = (entry: {
      meetingId: string;
      opportunityId: string;
      reason: string;
    }) => {
      if (skippedMeetings.length < 25) {
        skippedMeetings.push(entry);
      }
    };

    for (const meeting of meetings) {
      if (meeting.assignedCloserId !== undefined) {
        continue;
      }

      const opportunity = await ctx.db.get(meeting.opportunityId);
      if (!opportunity) {
        addSkippedMeeting({
          meetingId: meeting._id,
          opportunityId: meeting.opportunityId,
          reason: "missing_opportunity",
        });
        continue;
      }

      const inferred = await inferOpportunityAssignedCloserId(ctx, opportunity);
      if (!inferred.assignedCloserId) {
        addSkippedMeeting({
          meetingId: meeting._id,
          opportunityId: opportunity._id,
          reason: inferred.reason,
        });
        continue;
      }

      if (opportunity.assignedCloserId !== inferred.assignedCloserId) {
        await ctx.db.patch(opportunity._id, {
          assignedCloserId: inferred.assignedCloserId,
          updatedAt: Date.now(),
        });
        opportunitiesPatched += 1;
      }

      await ctx.db.patch(meeting._id, {
        assignedCloserId: inferred.assignedCloserId,
      });
      updated += 1;
      inferredByReason[inferred.reason] =
        (inferredByReason[inferred.reason] ?? 0) + 1;
    }

    console.log("[Migration:2C] Meeting closer backfill complete", {
      inferredByReason,
      opportunitiesPatched,
      skippedMeetings,
      updated,
      total: meetings.length,
    });

    return {
      inferredByReason,
      opportunitiesPatched,
      skippedMeetings,
      updated,
      total: meetings.length,
    };
  },
});

export const backfillCustomerTotals = mutation({
  args: {},
  handler: async (ctx) => {
    await requireSystemAdmin(ctx);

    const customers = await ctx.db.query("customers").collect();
    let updated = 0;

    for (const customer of customers) {
      const payments = await ctx.db
        .query("paymentRecords")
        .withIndex("by_customerId", (q) => q.eq("customerId", customer._id))
        .collect();
      const nonDisputedPayments = payments.filter(
        (payment) => payment.status !== "disputed",
      );
      const totalPaidMinor = nonDisputedPayments.reduce(
        (sum, payment) => sum + payment.amountMinor,
        0,
      );

      await ctx.db.patch(customer._id, {
        totalPaidMinor,
        totalPaymentCount: nonDisputedPayments.length,
        paymentCurrency:
          nonDisputedPayments[0]?.currency ??
          customer.paymentCurrency ??
          "USD",
      });
      updated += 1;
    }

    console.log("[Migration:2C] Customer totals backfill complete", {
      updated,
      total: customers.length,
    });

    return { updated, total: customers.length };
  },
});

export const seedTenantStats = mutation({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    await requireSystemAdmin(ctx);

    const result: SeedTenantStatsInternalResult = await ctx.runMutation(
      internal.admin.migrations.seedTenantStatsInternal,
      { tenantId },
    );

    console.log("[Migration:2D] tenantStats seed complete", {
      tenantId,
      action: result.action,
    });

    return result;
  },
});

export const seedAllTenantStats = action({
  args: {},
  handler: async (ctx) => {
    await requireSystemAdmin(ctx);

    const tenantIds: Id<"tenants">[] = await ctx.runQuery(
      internal.admin.migrations.getActiveTenantIds,
      {},
    );

    let created = 0;
    let updated = 0;
    for (const tenantId of tenantIds) {
      const result: SeedTenantStatsInternalResult = await ctx.runMutation(
        internal.admin.migrations.seedTenantStatsInternal,
        { tenantId },
      );
      if (result.action === "created") {
        created += 1;
      } else {
        updated += 1;
      }
    }

    console.log("[Migration:2D] Seeded tenantStats for active tenants", {
      created,
      updated,
      totalTenants: tenantIds.length,
    });

    return {
      created,
      updated,
      totalTenants: tenantIds.length,
    };
  },
});

export const deduplicateEventTypeConfigs = mutation({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    await requireSystemAdmin(ctx);

    const result: DeduplicateEventTypeConfigsInternalResult =
      await ctx.runMutation(
        internal.admin.migrations.deduplicateEventTypeConfigsInternal,
        { tenantId },
      );

    console.log("[Migration:2E] Event type config dedupe complete", {
      tenantId,
      ...result,
    });

    return result;
  },
});

export const deduplicateAllEventTypeConfigs = action({
  args: {},
  handler: async (ctx) => {
    await requireSystemAdmin(ctx);

    const tenantIds: Id<"tenants">[] = await ctx.runQuery(
      internal.admin.migrations.getAllTenantIds,
      {},
    );

    let deleted = 0;
    let fieldCatalogRowsDeleted = 0;
    let fieldCatalogRowsMerged = 0;
    let opportunitiesRepointed = 0;
    let responsesRepointed = 0;

    for (const tenantId of tenantIds) {
      const result: DeduplicateEventTypeConfigsInternalResult =
        await ctx.runMutation(
          internal.admin.migrations.deduplicateEventTypeConfigsInternal,
          { tenantId },
        );
      deleted += result.deleted;
      fieldCatalogRowsDeleted += result.fieldCatalogRowsDeleted;
      fieldCatalogRowsMerged += result.fieldCatalogRowsMerged;
      opportunitiesRepointed += result.opportunitiesRepointed;
      responsesRepointed += result.responsesRepointed;
    }

    console.log("[Migration:2E] Event type config dedupe complete for all tenants", {
      totalTenants: tenantIds.length,
      deleted,
      fieldCatalogRowsDeleted,
      fieldCatalogRowsMerged,
      opportunitiesRepointed,
      responsesRepointed,
    });

    return {
      totalTenants: tenantIds.length,
      deleted,
      fieldCatalogRowsDeleted,
      fieldCatalogRowsMerged,
      opportunitiesRepointed,
      responsesRepointed,
    };
  },
});

export const auditOrphanedTenantRows = query({
  args: {},
  handler: async (ctx) => {
    await requireSystemAdmin(ctx);

    const tenantIds = new Set<Id<"tenants">>();
    for await (const tenant of ctx.db.query("tenants")) {
      tenantIds.add(tenant._id);
    }

    const orphans: Partial<Record<TenantScopedTable, number>> = {};
    const samples: Partial<Record<TenantScopedTable, string[]>> = {};
    let totalOrphans = 0;

    for (const table of TENANT_SCOPED_TABLES) {
      let count = 0;
      const sampleIds: string[] = [];
      for await (const row of ctx.db.query(table)) {
        if (tenantIds.has(row.tenantId)) {
          continue;
        }

        count += 1;
        totalOrphans += 1;
        if (sampleIds.length < 5) {
          sampleIds.push(row._id);
        }
      }

      if (count > 0) {
        orphans[table] = count;
        samples[table] = sampleIds;
      }
    }

    if (totalOrphans === 0) {
      console.log("[Audit:2F] No orphaned tenant-scoped rows found");
    } else {
      console.warn("[Audit:2F] Orphaned tenant-scoped rows found", {
        totalOrphans,
        orphans,
        samples,
      });
    }

    return {
      totalOrphans,
      orphans,
      samples,
    };
  },
});

export const auditOrphanedUserRefs = query({
  args: {},
  handler: async (ctx) => {
    await requireSystemAdmin(ctx);

    const userIds = new Set<Id<"users">>();
    for await (const user of ctx.db.query("users")) {
      userIds.add(user._id);
    }

    const issues: UserReferenceIssue[] = [];

    for await (const tenant of ctx.db.query("tenants")) {
      addMissingUserIssue(issues, userIds, {
        table: "tenants",
        field: "tenantOwnerId",
        recordId: tenant._id,
        userId: tenant.tenantOwnerId,
      });
    }

    for await (const member of ctx.db.query("calendlyOrgMembers")) {
      addMissingUserIssue(issues, userIds, {
        table: "calendlyOrgMembers",
        field: "matchedUserId",
        recordId: member._id,
        userId: member.matchedUserId,
      });
    }

    for await (const leadMerge of ctx.db.query("leadMergeHistory")) {
      addMissingUserIssue(issues, userIds, {
        table: "leadMergeHistory",
        field: "mergedByUserId",
        recordId: leadMerge._id,
        userId: leadMerge.mergedByUserId,
      });
    }

    for await (const opportunity of ctx.db.query("opportunities")) {
      addMissingUserIssue(issues, userIds, {
        table: "opportunities",
        field: "assignedCloserId",
        recordId: opportunity._id,
        userId: opportunity.assignedCloserId,
      });
      addMissingUserIssue(issues, userIds, {
        table: "opportunities",
        field: "lostByUserId",
        recordId: opportunity._id,
        userId: opportunity.lostByUserId,
      });
    }

    for await (const meeting of ctx.db.query("meetings")) {
      addMissingUserIssue(issues, userIds, {
        table: "meetings",
        field: "assignedCloserId",
        recordId: meeting._id,
        userId: meeting.assignedCloserId,
      });
      addMissingUserIssue(issues, userIds, {
        table: "meetings",
        field: "reassignedFromCloserId",
        recordId: meeting._id,
        userId: meeting.reassignedFromCloserId,
      });
      addMissingUserIssue(issues, userIds, {
        table: "meetings",
        field: "noShowMarkedByUserId",
        recordId: meeting._id,
        userId: meeting.noShowMarkedByUserId,
      });
    }

    for await (const unavailability of ctx.db.query("closerUnavailability")) {
      addMissingUserIssue(issues, userIds, {
        table: "closerUnavailability",
        field: "closerId",
        recordId: unavailability._id,
        userId: unavailability.closerId,
      });
      addMissingUserIssue(issues, userIds, {
        table: "closerUnavailability",
        field: "createdByUserId",
        recordId: unavailability._id,
        userId: unavailability.createdByUserId,
      });
    }

    for await (const reassignment of ctx.db.query("meetingReassignments")) {
      addMissingUserIssue(issues, userIds, {
        table: "meetingReassignments",
        field: "fromCloserId",
        recordId: reassignment._id,
        userId: reassignment.fromCloserId,
      });
      addMissingUserIssue(issues, userIds, {
        table: "meetingReassignments",
        field: "toCloserId",
        recordId: reassignment._id,
        userId: reassignment.toCloserId,
      });
      addMissingUserIssue(issues, userIds, {
        table: "meetingReassignments",
        field: "reassignedByUserId",
        recordId: reassignment._id,
        userId: reassignment.reassignedByUserId,
      });
    }

    for await (const customer of ctx.db.query("customers")) {
      addMissingUserIssue(issues, userIds, {
        table: "customers",
        field: "convertedByUserId",
        recordId: customer._id,
        userId: customer.convertedByUserId,
      });
    }

    for await (const payment of ctx.db.query("paymentRecords")) {
      addMissingUserIssue(issues, userIds, {
        table: "paymentRecords",
        field: "closerId",
        recordId: payment._id,
        userId: payment.closerId,
      });
      addMissingUserIssue(issues, userIds, {
        table: "paymentRecords",
        field: "verifiedByUserId",
        recordId: payment._id,
        userId: payment.verifiedByUserId,
      });
    }

    for await (const followUp of ctx.db.query("followUps")) {
      addMissingUserIssue(issues, userIds, {
        table: "followUps",
        field: "closerId",
        recordId: followUp._id,
        userId: followUp.closerId,
      });
    }

    for await (const domainEvent of ctx.db.query("domainEvents")) {
      addMissingUserIssue(issues, userIds, {
        table: "domainEvents",
        field: "actorUserId",
        recordId: domainEvent._id,
        userId: domainEvent.actorUserId,
      });
    }

    if (issues.length === 0) {
      console.log("[Audit:2F] No orphaned user references found");
    } else {
      console.warn("[Audit:2F] Orphaned user references found", {
        totalIssues: issues.length,
        issues,
      });
    }

    return {
      issues,
      totalIssues: issues.length,
    };
  },
});

export const backfillTenantCalendlyConnections = mutation({
  args: {},
  handler: async (ctx) => {
    await requireSystemAdmin(ctx);

    const tenants = await ctx.db.query("tenants").collect();
    let createdDisconnected = 0;
    let createdFromLegacy = 0;
    let patchedExisting = 0;
    let skippedExisting = 0;
    const sampleCreated: string[] = [];
    const samplePatched: string[] = [];

    for (const tenant of tenants) {
      const existing = await ctx.db
        .query("tenantCalendlyConnections")
        .withIndex("by_tenantId", (q) => q.eq("tenantId", tenant._id))
        .first();

      const legacyPatch = getLegacyTenantCalendlyConnectionPatch(tenant);
      const storedLegacyPatch = toStoredPatch(legacyPatch ?? {});

      if (!existing) {
        await ctx.db.insert("tenantCalendlyConnections", {
          tenantId: tenant._id,
          ...storedLegacyPatch,
          connectionStatus: legacyPatch?.connectionStatus ?? "disconnected",
        });

        if (legacyPatch) {
          createdFromLegacy += 1;
        } else {
          createdDisconnected += 1;
        }
        addSampleId(sampleCreated, tenant._id);
        continue;
      }

      const repairPatch: Partial<Doc<"tenantCalendlyConnections">> = {};

      if (
        existing.calendlyAccessToken === undefined &&
        storedLegacyPatch.calendlyAccessToken !== undefined
      ) {
        repairPatch.calendlyAccessToken = storedLegacyPatch.calendlyAccessToken;
      }
      if (
        existing.calendlyRefreshToken === undefined &&
        storedLegacyPatch.calendlyRefreshToken !== undefined
      ) {
        repairPatch.calendlyRefreshToken = storedLegacyPatch.calendlyRefreshToken;
      }
      if (
        existing.calendlyTokenExpiresAt === undefined &&
        storedLegacyPatch.calendlyTokenExpiresAt !== undefined
      ) {
        repairPatch.calendlyTokenExpiresAt =
          storedLegacyPatch.calendlyTokenExpiresAt;
      }
      if (
        existing.calendlyRefreshLockUntil === undefined &&
        storedLegacyPatch.calendlyRefreshLockUntil !== undefined
      ) {
        repairPatch.calendlyRefreshLockUntil =
          storedLegacyPatch.calendlyRefreshLockUntil;
      }
      if (
        existing.lastTokenRefreshAt === undefined &&
        storedLegacyPatch.lastTokenRefreshAt !== undefined
      ) {
        repairPatch.lastTokenRefreshAt = storedLegacyPatch.lastTokenRefreshAt;
      }
      if (
        existing.codeVerifier === undefined &&
        storedLegacyPatch.codeVerifier !== undefined
      ) {
        repairPatch.codeVerifier = storedLegacyPatch.codeVerifier;
      }
      if (
        existing.calendlyOrganizationUri === undefined &&
        storedLegacyPatch.calendlyOrganizationUri !== undefined
      ) {
        repairPatch.calendlyOrganizationUri =
          storedLegacyPatch.calendlyOrganizationUri;
      }
      if (
        existing.calendlyUserUri === undefined &&
        storedLegacyPatch.calendlyUserUri !== undefined
      ) {
        repairPatch.calendlyUserUri = storedLegacyPatch.calendlyUserUri;
      }
      if (
        existing.calendlyWebhookUri === undefined &&
        storedLegacyPatch.calendlyWebhookUri !== undefined
      ) {
        repairPatch.calendlyWebhookUri = storedLegacyPatch.calendlyWebhookUri;
      }
      if (
        existing.calendlyWebhookSigningKey === undefined &&
        storedLegacyPatch.calendlyWebhookSigningKey !== undefined
      ) {
        repairPatch.calendlyWebhookSigningKey =
          storedLegacyPatch.calendlyWebhookSigningKey;
      }
      if (
        existing.webhookProvisioningStartedAt === undefined &&
        storedLegacyPatch.webhookProvisioningStartedAt !== undefined
      ) {
        repairPatch.webhookProvisioningStartedAt =
          storedLegacyPatch.webhookProvisioningStartedAt;
      }

      if (
        legacyPatch?.connectionStatus !== undefined &&
        (existing.connectionStatus === undefined ||
          (existing.connectionStatus === "disconnected" &&
            existing.calendlyAccessToken === undefined &&
            existing.calendlyRefreshToken === undefined &&
            legacyPatch.connectionStatus !== "disconnected"))
      ) {
        repairPatch.connectionStatus = legacyPatch.connectionStatus;
      }

      if (Object.keys(repairPatch).length === 0) {
        skippedExisting += 1;
        continue;
      }

      await ctx.db.patch(existing._id, repairPatch);
      patchedExisting += 1;
      addSampleId(samplePatched, tenant._id);
    }

    console.log("[Migration:5A] Tenant Calendly connections backfill complete", {
      createdDisconnected,
      createdFromLegacy,
      patchedExisting,
      sampleCreated,
      samplePatched,
      skippedExisting,
      total: tenants.length,
    });

    return {
      createdDisconnected,
      createdFromLegacy,
      patchedExisting,
      sampleCreated,
      samplePatched,
      skippedExisting,
      total: tenants.length,
    };
  },
});

export const auditPhase6Readiness = query({
  args: {},
  handler: async (ctx): Promise<Phase6ReadinessReport> => {
    await requireSystemAdmin(ctx);

    const report: Phase6ReadinessReport = {
      followUpsMissingType: 0,
      leadsInvalidCustomFields: 0,
      leadsMissingStatus: 0,
      meetingsMissingAssignedCloserId: 0,
      paymentsMissingAmountMinor: 0,
      paymentsMissingContextType: 0,
      paymentsWithLegacyAmountField: 0,
      sampleIds: {
        followUpsMissingType: [],
        leadsInvalidCustomFields: [],
        leadsMissingStatus: [],
        meetingsMissingAssignedCloserId: [],
        paymentsMissingAmountMinor: [],
        paymentsMissingContextType: [],
        paymentsWithLegacyAmountField: [],
        tenantsMissingCalendlyConnection: [],
        tenantsWithLegacyOAuthFields: [],
        usersMissingIsActive: [],
      },
      tenantsMissingCalendlyConnection: 0,
      tenantsWithLegacyOAuthFields: 0,
      usersMissingIsActive: 0,
    };

    const tenants = await ctx.db.query("tenants").collect();
    const connectionTenantIds = new Set<Id<"tenants">>();
    for await (const connection of ctx.db.query("tenantCalendlyConnections")) {
      connectionTenantIds.add(connection.tenantId);
    }

    const deprecatedTenantOAuthFields = [
      "calendlyAccessToken",
      "calendlyRefreshToken",
      "calendlyTokenExpiresAt",
      "calendlyRefreshLockUntil",
      "lastTokenRefreshAt",
      "codeVerifier",
      "calendlyOrgUri",
      "calendlyOwnerUri",
      "calendlyWebhookUri",
      "webhookSigningKey",
      "webhookProvisioningStartedAt",
    ] as const;

    for (const tenant of tenants) {
      if (!connectionTenantIds.has(tenant._id)) {
        report.tenantsMissingCalendlyConnection += 1;
        addSampleId(
          report.sampleIds.tenantsMissingCalendlyConnection,
          tenant._id,
        );
      }

      const rawTenant = tenant as Record<string, unknown>;
      if (
        deprecatedTenantOAuthFields.some((field) =>
          hasDefinedField(rawTenant, field),
        )
      ) {
        report.tenantsWithLegacyOAuthFields += 1;
        addSampleId(report.sampleIds.tenantsWithLegacyOAuthFields, tenant._id);
      }
    }

    for await (const user of ctx.db.query("users")) {
      if (user.isActive === undefined) {
        report.usersMissingIsActive += 1;
        addSampleId(report.sampleIds.usersMissingIsActive, user._id);
      }
    }

    for await (const lead of ctx.db.query("leads")) {
      if (lead.status === undefined) {
        report.leadsMissingStatus += 1;
        addSampleId(report.sampleIds.leadsMissingStatus, lead._id);
      }

      if (lead.customFields === undefined) {
        continue;
      }

      if (
        typeof lead.customFields !== "object" ||
        lead.customFields === null ||
        Array.isArray(lead.customFields)
      ) {
        report.leadsInvalidCustomFields += 1;
        addSampleId(report.sampleIds.leadsInvalidCustomFields, lead._id);
        continue;
      }

      const values = Object.values(lead.customFields as Record<string, unknown>);
      if (values.some((value) => typeof value !== "string")) {
        report.leadsInvalidCustomFields += 1;
        addSampleId(report.sampleIds.leadsInvalidCustomFields, lead._id);
      }
    }

    for await (const meeting of ctx.db.query("meetings")) {
      if (meeting.assignedCloserId === undefined) {
        report.meetingsMissingAssignedCloserId += 1;
        addSampleId(report.sampleIds.meetingsMissingAssignedCloserId, meeting._id);
      }
    }

    for await (const followUp of ctx.db.query("followUps")) {
      if (followUp.type === undefined) {
        report.followUpsMissingType += 1;
        addSampleId(report.sampleIds.followUpsMissingType, followUp._id);
      }
    }

    for await (const payment of ctx.db.query("paymentRecords")) {
      if (payment.amountMinor === undefined) {
        report.paymentsMissingAmountMinor += 1;
        addSampleId(report.sampleIds.paymentsMissingAmountMinor, payment._id);
      }

      if (payment.contextType === undefined) {
        report.paymentsMissingContextType += 1;
        addSampleId(report.sampleIds.paymentsMissingContextType, payment._id);
      }

      if (hasDefinedField(payment as Record<string, unknown>, "amount")) {
        report.paymentsWithLegacyAmountField += 1;
        addSampleId(report.sampleIds.paymentsWithLegacyAmountField, payment._id);
      }
    }

    console.log("[Audit:6] Phase 6 readiness", report);
    return report;
  },
});

export const auditPaymentCurrencies = query({
  args: {},
  handler: async (ctx) => {
    await requireSystemAdmin(ctx);

    const report: TenantCurrencyAudit[] = [];
    for await (const tenant of ctx.db.query("tenants")) {
      const payments = await ctx.db
        .query("paymentRecords")
        .withIndex("by_tenantId", (q) => q.eq("tenantId", tenant._id))
        .collect();
      if (payments.length === 0) {
        continue;
      }

      const counts: Record<string, number> = {};
      for (const payment of payments) {
        const currency = payment.currency.trim().toUpperCase() || "UNKNOWN";
        counts[currency] = (counts[currency] ?? 0) + 1;
      }

      const currencies = Object.keys(counts).sort();
      report.push({
        tenantId: tenant._id,
        currencies,
        counts,
        isConsistent: currencies.length === 1,
      });
    }

    const inconsistentTenants = report.filter(
      (tenant) => !tenant.isConsistent,
    );
    if (inconsistentTenants.length === 0) {
      console.log("[Audit:2F] Payment currencies are consistent for all tenants");
    } else {
      console.warn("[Audit:2F] Mixed tenant currencies detected", {
        inconsistentTenants,
      });
    }

    return {
      report,
      totalTenants: report.length,
      inconsistentTenants: inconsistentTenants.length,
    };
  },
});
