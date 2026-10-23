import { deleteActivityEventCounts } from "../reporting/activityEventCounts";
import { deletePipelineHealthAggregates } from "../reporting/pipelineHealthAggregates";
import { patchMeetingLifecycle } from "../lib/meetingLifecycle";
import { patchOpportunityLifecycle } from "../lib/opportunityActivity";
import { requestMeetingProjection } from "../operations/meetingStats";
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
import {
  extractQuestionsAndAnswers,
  writeMeetingFormResponses,
} from "../lib/meetingFormResponses";
import {
  deleteDealAttributions,
  deleteMeetingAttributions,
} from "../lib/attribution/dealAttributions";
import { log } from "../lib/observability/log";
import { getString, isRecord } from "../lib/payloadExtraction";
import {
  getLegacyTenantCalendlyConnectionPatch,
  toStoredPatch,
} from "../lib/tenantCalendlyConnection";
import {
  normalizePaymentOrigin,
  paymentTypeValidator,
  resolveLegacyCompatibleAttributedCloserId,
  resolveLegacyCompatiblePaymentProgramName,
  resolveLegacyCompatibleRecordedByUserId,
  resolvePaymentType,
} from "../lib/paymentTypes";
import {
  ensureProgramForTenant,
  findProgramByNormalizedName,
  normalizeProgramName,
} from "../tenantPrograms/shared";
import { requireSystemAdminSession } from "../requireSystemAdmin";

const RAW_EVENT_BACKFILL_PAGE_SIZE = 25;

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

type PaymentProgramsCutoverAudit = {
  paymentsMissingPaymentType: number;
  paymentsMissingProgramId: number;
  paymentsMissingProgramName: number;
  paymentsMissingRecordedByUserId: number;
  paymentsUsingLegacyFields: number;
  paymentsUsingLegacyOrigin: number;
  sampleLegacyPayments: Array<{
    amountMinor: number;
    opportunityId: string | null;
    origin: string | null;
    paymentId: string;
    programName: string | null;
    provider: string | null;
    recordedAt: number;
  }>;
  tenantProgramCount: number;
  totalPayments: number;
};

type LegacyPaymentMigrationRow = Doc<"paymentRecords"> & {
  closerId?: Id<"users">;
  provider?: string;
  loggedByAdminUserId?: Id<"users">;
  origin?: string;
};

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
    const existingConfig = await ctx.db.get("eventTypeConfigs", args.opportunity.eventTypeConfigId);
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
    const rawEvent = await ctx.db.get("rawWebhookEvents", rawEventId);
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
    } catch {
      // Counted as eventsSkippedInvalidJson in the run's completed line.
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

    const opportunity = await ctx.db.get("opportunities", meeting.opportunityId);
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

    const writeResult = await writeMeetingFormResponses(ctx, {
      tenantId: rawEvent.tenantId,
      meetingId: meeting._id,
      opportunityId: opportunity._id,
      leadId: opportunity.leadId,
      eventTypeConfigId,
      capturedAt: rawEvent.receivedAt,
      questionsAndAnswers,
    });

    return {
      status: "processed",
      eventsProcessed: 1,
      responsesCreated: writeResult.responsesCreated,
      responsesUpdated: writeResult.responsesUpdated,
      fieldCatalogCreated: writeResult.fieldCatalogCreated,
      fieldCatalogUpdated: writeResult.fieldCatalogUpdated,
      questionsSkipped: writeResult.questionsSkipped,
      eventTypeConfigIdResolved: !!eventTypeConfigId,
    };
  },
});

/** Removes the retired counters in a bounded batch; rerun until found is zero. */
export const deleteTenantStatsRows = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  returns: v.object({
    dryRun: v.boolean(),
    found: v.number(),
    deleted: v.number(),
    ids: v.array(v.id("tenantStats")),
  }),
  handler: async (ctx, { dryRun = false }) => {
    const rows = await ctx.db.query("tenantStats").take(100);
    if (!dryRun) {
      for (const row of rows) {
        await ctx.db.delete("tenantStats", row._id);
      }
    }
    return {
      dryRun,
      found: rows.length,
      deleted: dryRun ? 0 : rows.length,
      ids: rows.map((row) => row._id),
    };
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

    for (const group of groupedConfigs.values()) {
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
        await ctx.db.patch("eventTypeConfigs", canonicalConfig._id, canonicalPatch);
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
              await ctx.db.patch("eventTypeFieldCatalog", existingCanonicalFieldCatalog._id, patch);
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

          const movedFieldCatalog = await ctx.db.get("eventTypeFieldCatalog", newCanonicalFieldCatalogId);
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
          await ctx.db.patch("opportunities", opportunity._id, {
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

          await ctx.db.patch("meetingFormResponses", response._id, patch);
          responsesRepointed += 1;
        }

        for (const duplicateFieldCatalog of duplicateFieldCatalogRows) {
          await ctx.db.delete("eventTypeFieldCatalog", duplicateFieldCatalog._id);
          fieldCatalogRowsDeleted += 1;
        }

        await ctx.db.delete("eventTypeConfigs", duplicate._id);
        deleted += 1;
      }
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
    const startedAt = Date.now();
    log.info("admin.migration.started", { migration: "backfill_meeting_form_responses", tenantId });

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

    log.info("admin.migration.completed", {
      migration: "backfill_meeting_form_responses",
      durationMs: Date.now() - startedAt,
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
    .withIndex("by_opportunityId_and_status_and_reason", (q) => q.eq("opportunityId", opportunity._id))
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
    .withIndex("by_opportunityId_and_recordedAt", (q) => q.eq("opportunityId", opportunity._id))
    .collect();
  for (const payment of payments) {
    collectCandidateCloser(
      candidateScores,
      payment.attributedCloserId,
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

export const backfillUserIsActive = mutation({
  args: {},
  handler: async (ctx) => {
    await requireSystemAdmin(ctx);
    log.info("admin.migration.started", { migration: "backfill_user_is_active" });

    const users = await ctx.db.query("users").collect();
    let updated = 0;
    for (const user of users) {
      if (user.isActive !== undefined) {
        continue;
      }

      await ctx.db.patch("users", user._id, { isActive: true });
      updated += 1;
    }

    log.info("admin.migration.completed", {
      migration: "backfill_user_is_active",
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
    log.info("admin.migration.started", { migration: "backfill_payment_amount_minor" });

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

      await ctx.db.patch("paymentRecords", payment._id, {
        amountMinor: Math.round(legacyAmount * 100),
      });
      updated += 1;
    }

    log.info("admin.migration.completed", {
      migration: "backfill_payment_amount_minor",
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

export const backfillFollowUpType = mutation({
  args: {},
  handler: async (ctx) => {
    await requireSystemAdmin(ctx);
    log.info("admin.migration.started", { migration: "backfill_follow_up_type" });

    const followUps = await ctx.db.query("followUps").collect();
    let updated = 0;
    for (const followUp of followUps) {
      if (followUp.type !== undefined) {
        continue;
      }

      await ctx.db.patch("followUps", followUp._id, {
        type: followUp.schedulingLinkUrl
          ? "scheduling_link"
          : "manual_reminder",
      });
      updated += 1;
    }

    log.info("admin.migration.completed", {
      migration: "backfill_follow_up_type",
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
    log.info("admin.migration.started", { migration: "backfill_meeting_closer_id" });

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

      const opportunity = await ctx.db.get("opportunities", meeting.opportunityId);
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
        await patchOpportunityLifecycle(ctx, opportunity._id, {
          assignedCloserId: inferred.assignedCloserId,
          updatedAt: Date.now(),
        });
        opportunitiesPatched += 1;
      }

      await patchMeetingLifecycle(ctx, meeting._id, {
        assignedCloserId: inferred.assignedCloserId,
      });
      updated += 1;
      inferredByReason[inferred.reason] =
        (inferredByReason[inferred.reason] ?? 0) + 1;
    }

    log.info("admin.migration.completed", {
      migration: "backfill_meeting_closer_id",
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

export const auditPaymentProgramsAndTypesCutover = query({
  args: {},
  handler: async (ctx): Promise<PaymentProgramsCutoverAudit> => {
    await requireSystemAdmin(ctx);

    const [payments, tenantPrograms] = await Promise.all([
      ctx.db.query("paymentRecords").collect(),
      ctx.db.query("tenantPrograms").collect(),
    ]);

    const audit: PaymentProgramsCutoverAudit = {
      paymentsMissingPaymentType: 0,
      paymentsMissingProgramId: 0,
      paymentsMissingProgramName: 0,
      paymentsMissingRecordedByUserId: 0,
      paymentsUsingLegacyFields: 0,
      paymentsUsingLegacyOrigin: 0,
      sampleLegacyPayments: [],
      tenantProgramCount: tenantPrograms.length,
      totalPayments: payments.length,
    };

    for (const payment of payments) {
      const legacyPayment = payment as LegacyPaymentMigrationRow;
      const legacyOrigin = legacyPayment.origin as string | undefined;
      if (payment.programId === undefined) {
        audit.paymentsMissingProgramId += 1;
      }
      if (payment.programName === undefined) {
        audit.paymentsMissingProgramName += 1;
      }
      if (payment.paymentType === undefined) {
        audit.paymentsMissingPaymentType += 1;
      }
      if (payment.recordedByUserId === undefined) {
        audit.paymentsMissingRecordedByUserId += 1;
      }
      if (legacyOrigin === "customer_flow") {
        audit.paymentsUsingLegacyOrigin += 1;
      }
      if (
        legacyPayment.closerId !== undefined ||
        legacyPayment.provider !== undefined ||
        legacyPayment.loggedByAdminUserId !== undefined
      ) {
        audit.paymentsUsingLegacyFields += 1;
      }

      if (
        (
          payment.programId === undefined ||
          payment.programName === undefined ||
          payment.paymentType === undefined ||
          payment.recordedByUserId === undefined ||
          legacyPayment.closerId !== undefined ||
          legacyPayment.provider !== undefined ||
          legacyPayment.loggedByAdminUserId !== undefined ||
          legacyOrigin === "customer_flow"
        ) &&
        audit.sampleLegacyPayments.length < 10
      ) {
        audit.sampleLegacyPayments.push({
          amountMinor: payment.amountMinor,
          opportunityId: payment.opportunityId ?? null,
          origin: payment.origin ?? null,
          paymentId: payment._id,
          programName: payment.programName ?? null,
          provider: legacyPayment.provider ?? null,
          recordedAt: payment.recordedAt,
        });
      }
    }

    return audit;
  },
});

export const backfillPaymentProgramsAndTypes = mutation({
  args: {
    defaultLegacyPaymentType: v.optional(paymentTypeValidator),
    paymentTypeOverrides: v.optional(v.record(v.string(), paymentTypeValidator)),
  },
  handler: async (ctx, args) => {
    await requireSystemAdmin(ctx);
    log.info("admin.migration.started", { migration: "backfill_payment_programs_and_types" });

    const payments = await ctx.db.query("paymentRecords").collect();
    const opportunityCache = new Map<Id<"opportunities">, Doc<"opportunities"> | null>();
    const eventTypeConfigCache = new Map<
      Id<"eventTypeConfigs">,
      Doc<"eventTypeConfigs"> | null
    >();
    const touchedProgramIds = new Set<Id<"tenantPrograms">>();
    const unresolvedPayments: string[] = [];
    const paymentTypeOverrides = args.paymentTypeOverrides ?? {};
    let paymentsPatched = 0;

    const getOpportunity = async (opportunityId: Id<"opportunities">) => {
      if (!opportunityCache.has(opportunityId)) {
        opportunityCache.set(opportunityId, await ctx.db.get("opportunities", opportunityId));
      }
      return opportunityCache.get(opportunityId) ?? null;
    };

    const getEventTypeConfig = async (eventTypeConfigId: Id<"eventTypeConfigs">) => {
      if (!eventTypeConfigCache.has(eventTypeConfigId)) {
        eventTypeConfigCache.set(eventTypeConfigId, await ctx.db.get("eventTypeConfigs", eventTypeConfigId));
      }
      return eventTypeConfigCache.get(eventTypeConfigId) ?? null;
    };

    const resolveProgramNameFromOpportunity = async (
      opportunityId: Id<"opportunities">,
    ) => {
      const opportunity = await getOpportunity(opportunityId);
      if (!opportunity?.eventTypeConfigId) {
        return undefined;
      }
      const eventTypeConfig = await getEventTypeConfig(opportunity.eventTypeConfigId);
      const displayName = eventTypeConfig?.displayName?.trim();
      return displayName || undefined;
    };

    const ensureCanonicalProgram = async (args: {
      createdByUserId: Id<"users">;
      defaultCurrency?: string;
      name: string;
      tenantId: Id<"tenants">;
    }) => {
      const existing = await findProgramByNormalizedName(
        ctx,
        args.tenantId,
        normalizeProgramName(args.name),
      );
      const program = existing
        ? existing
        : await ensureProgramForTenant(ctx, {
            tenantId: args.tenantId,
            createdByUserId: args.createdByUserId,
            name: args.name,
            defaultCurrency: args.defaultCurrency,
          });
      touchedProgramIds.add(program._id);
      return program;
    };

    for (const payment of payments) {
      const legacyPayment = payment as LegacyPaymentMigrationRow;
      const resolvedOrigin = normalizePaymentOrigin(legacyPayment.origin);
      const resolvedAttributedCloserId =
        resolveLegacyCompatibleAttributedCloserId(legacyPayment);
      const resolvedRecordedByUserId =
        resolveLegacyCompatibleRecordedByUserId(legacyPayment);
      const overridePaymentType = paymentTypeOverrides[payment._id];
      const resolvedPaymentType =
        payment.paymentType ??
        overridePaymentType ??
        args.defaultLegacyPaymentType;

      let programId = payment.programId;
      let programName = resolveLegacyCompatiblePaymentProgramName(legacyPayment);

      if (!programName && payment.opportunityId) {
        programName = await resolveProgramNameFromOpportunity(payment.opportunityId);
      }

      if ((programId === undefined || programName === undefined) && programName) {
        const programCreatorUserId =
          resolvedRecordedByUserId ?? legacyPayment.closerId;
        if (!programCreatorUserId) {
          unresolvedPayments.push(`${payment._id}:missing_program_creator`);
          continue;
        }
        const program = await ensureCanonicalProgram({
          tenantId: payment.tenantId,
          createdByUserId: programCreatorUserId,
          name: programName,
          defaultCurrency: payment.currency,
        });
        programId = program._id;
        programName = program.name;
      }

      if (resolvedRecordedByUserId === undefined) {
        unresolvedPayments.push(`${payment._id}:missing_recordedByUserId`);
        continue;
      }
      if (resolvedAttributedCloserId === undefined) {
        unresolvedPayments.push(`${payment._id}:missing_attributedCloserId`);
        continue;
      }
      if (programId === undefined || programName === undefined) {
        unresolvedPayments.push(`${payment._id}:missing_program`);
        continue;
      }
      if (resolvedPaymentType === undefined) {
        unresolvedPayments.push(`${payment._id}:missing_paymentType`);
        continue;
      }

      const patch: Partial<Doc<"paymentRecords">> = {};
      if (payment.programId !== programId) {
        patch.programId = programId;
      }
      if (payment.programName !== programName) {
        patch.programName = programName;
      }
      if (payment.paymentType !== resolvedPaymentType) {
        patch.paymentType = resolvePaymentType(resolvedPaymentType);
      }
      if (payment.recordedByUserId !== resolvedRecordedByUserId) {
        patch.recordedByUserId = resolvedRecordedByUserId;
      }
      if (payment.attributedCloserId !== resolvedAttributedCloserId) {
        patch.attributedCloserId = resolvedAttributedCloserId;
      }
      if (payment.origin !== resolvedOrigin) {
        patch.origin = resolvedOrigin;
      }

      if (Object.keys(patch).length === 0) {
        continue;
      }

      await ctx.db.patch("paymentRecords", payment._id, patch);
      paymentsPatched += 1;
    }

    if (unresolvedPayments.length > 0) {
      throw new Error(
        JSON.stringify({
          unresolvedPayments: unresolvedPayments.slice(0, 10),
        }),
      );
    }

    log.info("admin.migration.completed", {
      migration: "backfill_payment_programs_and_types",
      paymentsPatched,
      tenantProgramsResolved: touchedProgramIds.size,
    });

    return {
      paymentsPatched,
      tenantProgramsResolved: touchedProgramIds.size,
    };
  },
});

export const deduplicateEventTypeConfigs = mutation({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    await requireSystemAdmin(ctx);
    log.info("admin.migration.started", { migration: "deduplicate_event_type_configs", tenantId });

    const result: DeduplicateEventTypeConfigsInternalResult =
      await ctx.runMutation(
        internal.admin.migrations.deduplicateEventTypeConfigsInternal,
        { tenantId },
      );

    log.info("admin.migration.completed", {
      migration: "deduplicate_event_type_configs",
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
    const startedAt = Date.now();
    log.info("admin.migration.started", { migration: "deduplicate_all_event_type_configs" });

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

    log.info("admin.migration.completed", {
      migration: "deduplicate_all_event_type_configs",
      durationMs: Date.now() - startedAt,
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

    for await (const payment of ctx.db.query("paymentRecords")) {
      addMissingUserIssue(issues, userIds, {
        table: "paymentRecords",
        field: "attributedCloserId",
        recordId: payment._id,
        userId: payment.attributedCloserId,
      });
      addMissingUserIssue(issues, userIds, {
        table: "paymentRecords",
        field: "recordedByUserId",
        recordId: payment._id,
        userId: payment.recordedByUserId,
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
    log.info("admin.migration.started", { migration: "backfill_tenant_calendly_connections" });

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

      await ctx.db.patch("tenantCalendlyConnections", existing._id, repairPatch);
      patchedExisting += 1;
      addSampleId(samplePatched, tenant._id);
    }

    log.info("admin.migration.completed", {
      migration: "backfill_tenant_calendly_connections",
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

export const auditPaymentCurrencies = query({
  args: {},
  handler: async (ctx) => {
    await requireSystemAdmin(ctx);

    const report: TenantCurrencyAudit[] = [];
    for await (const tenant of ctx.db.query("tenants")) {
      const payments = await ctx.db
        .query("paymentRecords")
        .withIndex("by_tenantId_and_recordedAt", (q) => q.eq("tenantId", tenant._id))
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
    return {
      report,
      totalTenants: report.length,
      inconsistentTenants: inconsistentTenants.length,
    };
  },
});

// ============================================================================
// Phase 6 Blocker Purge — BATCHED DESTRUCTIVE CLEANUP
// ============================================================================
//
// Removes the two categories of records blocking the Phase 6 schema narrowing
// deploy, plus every related child record to avoid referential inconsistency.
//
// Blocker A: opportunities whose meetings have no assignedCloserId
//   (the Calendly host could not be mapped to a closer user).
//   → cascade-deletes: opportunity, meetings, followUps, paymentRecords,
//     meetingFormResponses, meetingReassignments, dealAttributions and
//     domainEvents. It ran before Phase 4, which removed its customer step.
//
// Blocker B: paymentRecords that still carry the legacy `amount` field
//   (cannot be stripped while the deployed schema still requires it).
//   → deletes the 2 affected payment records and their proof files.
//
// Leaves alone: leads, users, calendlyOrgMembers, tenantCalendlyConnections,
// eventTypeConfigs, eventTypeFieldCatalog, rawWebhookEvents.
// ============================================================================

// Aggregate deletion does 5-6 entries per event, each with several index reads.
const BLOCKER_EVENT_BATCH_SIZE = 40;

export const purgePhase6BlockerRecords = mutation({
  args: {},
  handler: async (ctx) => {
    await requireSystemAdmin(ctx);
    log.info("admin.migration.started", { migration: "purge_phase6_blocker_records" });

    const counts = {
      opportunities: 0,
      meetings: 0,
      followUps: 0,
      paymentRecords: 0,
      paymentProofFiles: 0,
      meetingFormResponses: 0,
      meetingReassignments: 0,
      domainEvents: 0,
      legacyPaymentsStripped: 0,
    };

    // ─── BLOCKER A: meetings without assignedCloserId ─────────────

    // Gather all meetings across all tenants (bounded: ~230 in production).
    const allMeetings = await ctx.db.query("meetings").collect();
    const blockerMeetings = allMeetings.filter(
      (m) => m.assignedCloserId === undefined,
    );

    // Unique opportunity IDs that need to be cascade-deleted.
    const opportunityIds = [
      ...new Set(blockerMeetings.map((m) => m.opportunityId)),
    ];

    // Counts describe this call. Repeat while hasMore to finish the purge.
    let hasMore = false;
    opportunities: for (const oppId of opportunityIds) {
      // 1. All meetings for this opportunity (not just blocker ones — delete the
      //    whole opportunity tree to avoid orphaned siblings).
      const oppMeetings = await ctx.db
        .query("meetings")
        .withIndex("by_opportunityId", (q) => q.eq("opportunityId", oppId))
        .collect();

      // Drain domain events before deleting parents, so a continuation can find them.
      // Use the tenantId from the first meeting of this opportunity.
      const tenantIdForOpp = oppMeetings[0]?.tenantId;
      if (tenantIdForOpp) {
        const oppEvents = await ctx.db
          .query("domainEvents")
          .withIndex(
            "by_tenantId_and_entityType_and_entityId_and_occurredAt",
            (q) =>
              q
                .eq("tenantId", tenantIdForOpp)
                .eq("entityType", "opportunity")
                .eq("entityId", oppId),
          )
          .take(BLOCKER_EVENT_BATCH_SIZE - counts.domainEvents);
        for (const evt of oppEvents) {
          await deleteActivityEventCounts(ctx, evt);
          await ctx.db.delete("domainEvents", evt._id);
          counts.domainEvents++;
        }
        if (counts.domainEvents === BLOCKER_EVENT_BATCH_SIZE) {
          hasMore = true;
          break opportunities;
        }
      }

      // The same event budget covers every meeting and opportunity in this call.
      for (const meeting of oppMeetings) {
        const meetingEvents = await ctx.db
          .query("domainEvents")
          .withIndex(
            "by_tenantId_and_entityType_and_entityId_and_occurredAt",
            (q) =>
              q
                .eq("tenantId", meeting.tenantId)
                .eq("entityType", "meeting")
                .eq("entityId", meeting._id),
          )
          .take(BLOCKER_EVENT_BATCH_SIZE - counts.domainEvents);
        for (const evt of meetingEvents) {
          await deleteActivityEventCounts(ctx, evt);
          await ctx.db.delete("domainEvents", evt._id);
          counts.domainEvents++;
        }
        if (counts.domainEvents === BLOCKER_EVENT_BATCH_SIZE) {
          hasMore = true;
          break opportunities;
        }
      }

      const meetingIdSet = new Set(oppMeetings.map((m) => m._id));

      // 2. meetingFormResponses
      for (const meeting of oppMeetings) {
        const formResponses = await ctx.db
          .query("meetingFormResponses")
          .withIndex("by_meetingId", (q) => q.eq("meetingId", meeting._id))
          .collect();
        for (const r of formResponses) {
          await ctx.db.delete("meetingFormResponses", r._id);
          counts.meetingFormResponses++;
        }
      }

      // 3. meetingReassignments
      for (const meeting of oppMeetings) {
        const reassignments = await ctx.db
          .query("meetingReassignments")
          .withIndex("by_meetingId", (q) => q.eq("meetingId", meeting._id))
          .collect();
        for (const r of reassignments) {
          await ctx.db.delete("meetingReassignments", r._id);
          counts.meetingReassignments++;
        }
      }

      // 4. followUps
      const followUps = await ctx.db
        .query("followUps")
        .withIndex("by_opportunityId_and_status_and_reason", (q) => q.eq("opportunityId", oppId))
        .collect();
      for (const fu of followUps) {
        await ctx.db.delete("followUps", fu._id);
        counts.followUps++;
      }

      // 5. paymentRecords (opportunity-scoped) + proof files
      const oppPayments = await ctx.db
        .query("paymentRecords")
        .withIndex("by_opportunityId_and_recordedAt", (q) => q.eq("opportunityId", oppId))
        .collect();
      for (const p of oppPayments) {
        if (p.proofFileId) {
          await ctx.storage.delete(p.proofFileId);
          counts.paymentProofFiles++;
        }
        await ctx.db.delete("paymentRecords", p._id);
        counts.paymentRecords++;
      }

      const opportunity = await ctx.db.get("opportunities", oppId);

      // 6. Clear rescheduledFromMeetingId on OTHER meetings that chain from
      //    any meeting we are about to delete (so we don't leave dangling refs).
      for (const meeting of oppMeetings) {
        const chainedMeetings = allMeetings.filter(
          (m) =>
            m.rescheduledFromMeetingId === meeting._id &&
            !meetingIdSet.has(m._id),
        );
        for (const m of chainedMeetings) {
          await ctx.db.patch("meetings", m._id, { rescheduledFromMeetingId: undefined });
        }
      }

      // 7. Delete meetings, with their attribution rows
      for (const meeting of oppMeetings) {
        await deleteMeetingAttributions(ctx, meeting.tenantId, meeting._id);
        await requestMeetingProjection(ctx, meeting.tenantId, meeting._id);
        await ctx.db.delete("meetings", meeting._id);
        counts.meetings++;
      }

      // 8. Delete the opportunity, with the rest of its attribution rows
      if (opportunity) {
        while (!(await deleteDealAttributions(ctx, opportunity.tenantId, oppId))) {
          // Each call deletes one page.
        }
      }
      if (opportunity) await deletePipelineHealthAggregates(ctx, opportunity);
      await ctx.db.delete("opportunities", oppId);
      counts.opportunities++;
    }

    // ─── BLOCKER B: payment records with legacy `amount` field ────

    const allPayments = await ctx.db.query("paymentRecords").collect();
    const legacyPayments = allPayments.filter((p) =>
      hasDefinedField(p as unknown as Record<string, unknown>, "amount"),
    );

    for (const p of legacyPayments) {
      if (p.proofFileId) {
        await ctx.storage.delete(p.proofFileId);
        counts.paymentProofFiles++;
      }
      await ctx.db.delete("paymentRecords", p._id);
      counts.legacyPaymentsStripped++;
    }

    log.info("admin.migration.completed", {
      migration: "purge_phase6_blocker_records",
      blockerMeetingsFound: blockerMeetings.length,
      blockerOpportunitiesFound: opportunityIds.length,
      legacyPaymentsFound: legacyPayments.length,
      hasMore,
      ...counts,
    });

    return {
      hasMore,
      blockerA: {
        blockerMeetingsFound: blockerMeetings.length,
        opportunitiesPurged: counts.opportunities,
        meetingsPurged: counts.meetings,
        followUpsPurged: counts.followUps,
        paymentRecordsPurged: counts.paymentRecords,
        proofFilesPurged: counts.paymentProofFiles,
        formResponsesPurged: counts.meetingFormResponses,
        reassignmentsPurged: counts.meetingReassignments,
        domainEventsPurged: counts.domainEvents,
      },
      blockerB: {
        legacyPaymentsPurged: counts.legacyPaymentsStripped,
      },
    };
  },
});

export const getQualificationProjectionReadiness = query({
  args: {},
  handler: async (ctx) => {
    await requireSystemAdmin(ctx);

    const tenants = await ctx.db.query("tenants").take(100);
    let slackSourcedOpportunities = 0;
    let qualificationEvents = 0;
    let projectionRows = 0;
    let rowsWithoutOpportunity = 0;
    let rowsWithoutLead = 0;

    for (const tenant of tenants) {
      const opportunities = await ctx.db
        .query("opportunities")
        .withIndex("by_tenantId_and_source_and_qualifiedAt", (q) =>
          q.eq("tenantId", tenant._id).eq("source", "slack_qualified"),
        )
        .take(1000);
      slackSourcedOpportunities += opportunities.length;

      const events = await ctx.db
        .query("slackQualificationEvents")
        .withIndex("by_tenantId_and_submittedAt", (q) =>
          q.eq("tenantId", tenant._id),
        )
        .take(1000);
      qualificationEvents += events.length;

      const rows = await ctx.db
        .query("operationsQualificationRows")
        .withIndex("by_tenantId_and_qualifiedAt", (q) =>
          q.eq("tenantId", tenant._id),
        )
        .take(1000);
      projectionRows += rows.length;
      rowsWithoutOpportunity += rows.filter(
        (row) => row.opportunityId === undefined,
      ).length;
      rowsWithoutLead += rows.filter((row) => row.leadId === undefined).length;
    }

    return {
      tenantsScanned: tenants.length,
      slackSourcedOpportunities,
      qualificationEvents,
      projectionRows,
      rowsWithoutOpportunity,
      rowsWithoutLead,
      truncated: tenants.length === 100,
    };
  },
});
