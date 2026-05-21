import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import {
  getUniqueFieldKey,
  loadFieldCatalogByKey,
  normalizeFieldKey,
  upsertEventTypeFieldCatalogEntry,
} from "../lib/eventTypeFields";
import {
  getTenantCalendlyConnectionState,
  updateTenantCalendlyConnection,
} from "../lib/tenantCalendlyConnection";
import { isRecord } from "../lib/payloadExtraction";

type NormalizedCustomQuestion = {
  label: string;
  baseFieldKey: string;
  valueType?: string;
};

type EventTypeSyncStatus = NonNullable<
  Doc<"eventTypeConfigs">["calendlySyncStatus"]
>;

type NormalizedCalendlyEventType = {
  uri: string;
  name?: string;
  schedulingUrl?: string;
  syncStatus: EventTypeSyncStatus;
  enabledCustomQuestions: NormalizedCustomQuestion[];
  calendlyPatch: Partial<Doc<"eventTypeConfigs">>;
};

type EventTypesPageResult = {
  created: number;
  updated: number;
  unchanged: number;
  inactive: number;
  deleted: number;
  questionsMerged: number;
};

const MAX_KNOWN_CUSTOM_FIELD_KEYS = 200;

function getNullableString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function getBoolean(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function getFiniteNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function normalizeHttpUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function normalizeProfile(value: unknown): {
  ownerUri?: string;
  profileName?: string;
} {
  if (!isRecord(value)) {
    return {};
  }

  return {
    ownerUri: getNullableString(value, "owner"),
    profileName: getNullableString(value, "name"),
  };
}

function normalizeCustomQuestions(value: unknown): NormalizedCustomQuestion[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const questions: NormalizedCustomQuestion[] = [];
  const usedKeys = new Set<string>();

  for (const item of value) {
    if (!isRecord(item) || item.enabled === false) {
      continue;
    }

    const label = getNullableString(item, "name");
    if (!label) {
      console.warn("[Calendly:EventTypes] Skipping malformed custom question");
      continue;
    }

    const baseKey = normalizeFieldKey(label);
    const fieldKey = getUniqueFieldKey(baseKey, usedKeys);
    usedKeys.add(fieldKey);

    questions.push({
      label,
      baseFieldKey: fieldKey,
      valueType: getNullableString(item, "type"),
    });
  }

  return questions;
}

export function normalizeCalendlyEventTypeResource(
  value: unknown,
): NormalizedCalendlyEventType | null {
  if (!isRecord(value)) {
    return null;
  }

  const uri = getNullableString(value, "uri");
  if (!uri) {
    console.warn("[Calendly:EventTypes] Skipping event type without uri");
    return null;
  }

  const name = getNullableString(value, "name");
  const schedulingUrl = normalizeHttpUrl(
    getNullableString(value, "scheduling_url"),
  );
  const deletedAt = getNullableString(value, "deleted_at");
  const active = getBoolean(value, "active");
  const profile = normalizeProfile(value.profile);
  const syncStatus: EventTypeSyncStatus = deletedAt
    ? "deleted"
    : active === false
      ? "inactive"
      : "active";

  return {
    uri,
    name,
    schedulingUrl,
    syncStatus,
    enabledCustomQuestions: normalizeCustomQuestions(value.custom_questions),
    calendlyPatch: {
      calendlyName: name,
      calendlySchedulingUrl: schedulingUrl,
      calendlySlug: getNullableString(value, "slug"),
      calendlyActive: deletedAt ? false : active,
      calendlyDeletedAt: deletedAt,
      calendlyCreatedAt: getNullableString(value, "created_at"),
      calendlyUpdatedAt: getNullableString(value, "updated_at"),
      calendlyDurationMinutes: getFiniteNumber(value, "duration"),
      calendlyKind: getNullableString(value, "kind"),
      calendlyType: getNullableString(value, "type"),
      calendlyBookingMethod: getNullableString(value, "booking_method"),
      calendlyPoolingType: getNullableString(value, "pooling_type"),
      calendlySecret: getBoolean(value, "secret"),
      calendlyAdminManaged: getBoolean(value, "admin_managed"),
      calendlyColor: getNullableString(value, "color"),
      calendlyLocale: getNullableString(value, "locale"),
      calendlyOwnerUri: profile.ownerUri,
      calendlyProfileName: profile.profileName,
      calendlySyncStatus: syncStatus,
    },
  };
}

function canSyncDisplayName(config: Doc<"eventTypeConfigs">) {
  return (
    config.displayNameSource === "calendly_synced" ||
    config.displayNameSource === "webhook_discovered"
  );
}

function valuesEqual(a: unknown, b: unknown) {
  return a === b;
}

function addPatchIfChanged<K extends keyof Doc<"eventTypeConfigs">>(
  patch: Partial<Doc<"eventTypeConfigs">>,
  existing: Doc<"eventTypeConfigs">,
  key: K,
  value: Doc<"eventTypeConfigs">[K] | undefined,
) {
  if (!valuesEqual(existing[key], value)) {
    patch[key] = value;
    return true;
  }
  return false;
}

function buildEventTypeConfigSyncPatch(
  existing: Doc<"eventTypeConfigs">,
  normalized: NormalizedCalendlyEventType,
  syncStartedAt: number,
): {
  patch: Partial<Doc<"eventTypeConfigs">>;
  materialChange: boolean;
} {
  const patch: Partial<Doc<"eventTypeConfigs">> = {};
  let materialChange = false;

  for (const [key, value] of Object.entries(normalized.calendlyPatch) as Array<
    [
      keyof Doc<"eventTypeConfigs">,
      Doc<"eventTypeConfigs">[keyof Doc<"eventTypeConfigs">] | undefined,
    ]
  >) {
    if (addPatchIfChanged(patch, existing, key, value)) {
      materialChange = true;
    }
  }

  if (normalized.name && canSyncDisplayName(existing)) {
    if (existing.displayName !== normalized.name) {
      patch.displayName = normalized.name;
      materialChange = true;
    }
    if (!existing.displayNameSource) {
      patch.displayNameSource = "calendly_synced";
      materialChange = true;
    }
  }

  if (
    normalized.schedulingUrl &&
    (!existing.bookingBaseUrl ||
      existing.bookingUrlSource === "calendly_synced")
  ) {
    if (existing.bookingBaseUrl !== normalized.schedulingUrl) {
      patch.bookingBaseUrl = normalized.schedulingUrl;
      materialChange = true;
    }
    if (existing.bookingUrlSource !== "calendly_synced") {
      patch.bookingUrlSource = "calendly_synced";
      materialChange = true;
    }
  }

  if (normalized.syncStatus === "deleted" && existing.linkPortalEnabled) {
    patch.linkPortalEnabled = false;
    materialChange = true;
  }

  if (existing.lastCalendlySeenAt !== syncStartedAt) {
    patch.lastCalendlySeenAt = syncStartedAt;
  }
  patch.lastCalendlySyncedAt = Date.now();

  if (materialChange) {
    patch.updatedAt = Date.now();
  }

  return { patch, materialChange };
}

function dedupeLabels(labels: string[]) {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const label of labels) {
    if (seen.has(label)) {
      continue;
    }
    seen.add(label);
    deduped.push(label);
  }
  return deduped;
}

async function mergeQuestionCatalog(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    eventTypeConfigId: Id<"eventTypeConfigs">;
    questions: NormalizedCustomQuestion[];
    seenAt: number;
  },
) {
  if (args.questions.length === 0) {
    return 0;
  }

  const config = await ctx.db.get(args.eventTypeConfigId);
  if (!config) {
    return 0;
  }

  const existingLabels = config.knownCustomFieldKeys ?? [];
  const labelsToMerge = args.questions.map((question) => question.label);
  const mergedKeys = dedupeLabels([...existingLabels, ...labelsToMerge]).slice(
    0,
    MAX_KNOWN_CUSTOM_FIELD_KEYS,
  );

  let changed = 0;
  if (
    mergedKeys.length !== existingLabels.length ||
    mergedKeys.some((label, index) => label !== existingLabels[index])
  ) {
    await ctx.db.patch(args.eventTypeConfigId, {
      knownCustomFieldKeys: mergedKeys,
      updatedAt: Date.now(),
    });
    changed += 1;
  }

  const catalog = await loadFieldCatalogByKey(ctx, args);
  const catalogByLabel = new Map<string, Doc<"eventTypeFieldCatalog">>();
  const usedKeys = new Set(catalog.keys());
  for (const entry of catalog.values()) {
    catalogByLabel.set(entry.currentLabel, entry);
  }

  for (const question of args.questions) {
    const existingForLabel = catalogByLabel.get(question.label);
    const fieldKey = existingForLabel
      ? existingForLabel.fieldKey
      : getUniqueFieldKey(question.baseFieldKey, usedKeys);
    usedKeys.add(fieldKey);

    const result = await upsertEventTypeFieldCatalogEntry(ctx, {
      existingEntriesByFieldKey: catalog,
      tenantId: args.tenantId,
      eventTypeConfigId: args.eventTypeConfigId,
      fieldKey,
      currentLabel: question.label,
      valueType: question.valueType,
      seenAt: args.seenAt,
    });
    if (result.action !== "unchanged") {
      changed += 1;
    }
    const catalogEntry = catalog.get(fieldKey);
    if (catalogEntry) {
      catalogByLabel.set(question.label, catalogEntry);
    }
  }

  return changed;
}

export const acquireEventTypeSyncLock = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    lockUntil: v.number(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { tenantId, lockUntil, reason }) => {
    const connection = await getTenantCalendlyConnectionState(ctx, tenantId);
    if (!connection) {
      throw new Error("Calendly connection not found.");
    }

    const now = Date.now();
    if (
      connection.eventTypeSyncLockUntil &&
      connection.eventTypeSyncLockUntil > now
    ) {
      return {
        acquired: false as const,
        lockUntil: connection.eventTypeSyncLockUntil,
      };
    }

    await updateTenantCalendlyConnection(ctx, tenantId, {
      eventTypeSyncLockUntil: lockUntil,
      lastEventTypeSyncStartedAt: now,
      lastEventTypeSyncStatus: undefined,
      lastEventTypeSyncError: undefined,
      lastEventTypeSyncCount: undefined,
      lastEventTypeSyncSummary: undefined,
    });

    console.log("[Calendly:EventTypes] sync lock acquired", {
      tenantId,
      reason,
      lockUntil,
    });

    return { acquired: true as const, lockUntil };
  },
});

export const completeEventTypeSync = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    status: v.union(
      v.literal("success"),
      v.literal("failed"),
      v.literal("skipped"),
    ),
    error: v.optional(v.string()),
    totals: v.optional(
      v.object({
        totalSeen: v.number(),
        created: v.number(),
        updated: v.number(),
        unchanged: v.number(),
        inactive: v.number(),
        deleted: v.number(),
        notReturned: v.number(),
        questionsMerged: v.number(),
      }),
    ),
  },
  handler: async (ctx, { tenantId, status, error, totals }) => {
    const connection = await getTenantCalendlyConnectionState(ctx, tenantId);
    if (!connection) {
      return;
    }

    await updateTenantCalendlyConnection(ctx, tenantId, {
      eventTypeSyncLockUntil: undefined,
      lastEventTypeSyncCompletedAt: Date.now(),
      lastEventTypeSyncStatus: status,
      lastEventTypeSyncError: error,
      lastEventTypeSyncCount: totals?.totalSeen,
      lastEventTypeSyncSummary: totals,
    });

    console.log("[Calendly:EventTypes] sync completed", {
      tenantId,
      status,
      totalSeen: totals?.totalSeen,
    });
  },
});

export const upsertEventTypesPage = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    syncStartedAt: v.number(),
    collection: v.array(v.any()),
  },
  handler: async (
    ctx,
    { tenantId, syncStartedAt, collection },
  ): Promise<EventTypesPageResult> => {
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let inactive = 0;
    let deleted = 0;
    let questionsMerged = 0;

    for (const resource of collection) {
      const normalized = normalizeCalendlyEventTypeResource(resource);
      if (!normalized) {
        continue;
      }

      if (normalized.syncStatus === "inactive") {
        inactive += 1;
      } else if (normalized.syncStatus === "deleted") {
        deleted += 1;
      }

      const existing = await ctx.db
        .query("eventTypeConfigs")
        .withIndex("by_tenantId_and_calendlyEventTypeUri", (q) =>
          q
            .eq("tenantId", tenantId)
            .eq("calendlyEventTypeUri", normalized.uri),
        )
        .unique();

      let eventTypeConfigId: Id<"eventTypeConfigs">;
      if (!existing) {
        const now = Date.now();
        const knownCustomFieldKeys = dedupeLabels(
          normalized.enabledCustomQuestions.map((question) => question.label),
        ).slice(0, MAX_KNOWN_CUSTOM_FIELD_KEYS);

        eventTypeConfigId = await ctx.db.insert("eventTypeConfigs", {
          tenantId,
          calendlyEventTypeUri: normalized.uri,
          displayName: normalized.name ?? "Calendly Event Type",
          displayNameSource: "calendly_synced",
          bookingProgramMappingStatus: "unmapped",
          bookingBaseUrl: normalized.schedulingUrl,
          bookingUrlSource: normalized.schedulingUrl
            ? "calendly_synced"
            : undefined,
          knownCustomFieldKeys:
            knownCustomFieldKeys.length > 0 ? knownCustomFieldKeys : undefined,
          ...normalized.calendlyPatch,
          lastCalendlySeenAt: syncStartedAt,
          lastCalendlySyncedAt: now,
          createdAt: now,
          updatedAt: now,
        });
        created += 1;
      } else {
        eventTypeConfigId = existing._id;
        const { patch, materialChange } = buildEventTypeConfigSyncPatch(
          existing,
          normalized,
          syncStartedAt,
        );

        if (Object.keys(patch).length > 0) {
          await ctx.db.patch(existing._id, patch);
        }
        if (materialChange) {
          updated += 1;
        } else {
          unchanged += 1;
        }
      }

      questionsMerged += await mergeQuestionCatalog(ctx, {
        tenantId,
        eventTypeConfigId,
        questions: normalized.enabledCustomQuestions,
        seenAt: syncStartedAt,
      });
    }

    return { created, updated, unchanged, inactive, deleted, questionsMerged };
  },
});

export const markMissingEventTypes = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    syncStartedAt: v.number(),
  },
  handler: async (ctx, { tenantId, syncStartedAt }) => {
    let notReturned = 0;
    const rows = ctx.db
      .query("eventTypeConfigs")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId));

    for await (const config of rows) {
      if (
        config.lastCalendlySyncedAt !== undefined &&
        config.lastCalendlySeenAt !== syncStartedAt &&
        config.calendlySyncStatus !== "deleted"
      ) {
        await ctx.db.patch(config._id, {
          calendlySyncStatus: "not_returned",
          calendlyActive: false,
          updatedAt: Date.now(),
        });
        notReturned += 1;
      }
    }

    console.log("[Calendly:EventTypes] missing event types marked", {
      tenantId,
      notReturned,
    });

    return { notReturned };
  },
});
