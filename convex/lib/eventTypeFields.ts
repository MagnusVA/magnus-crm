import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export function normalizeFieldKey(question: string): string {
  return (
    question
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/_+/g, "_") || "unknown"
  );
}

export function getUniqueFieldKey(
  baseKey: string,
  usedKeys: Set<string>,
): string {
  if (!usedKeys.has(baseKey)) {
    return baseKey;
  }

  let suffix = 2;
  while (usedKeys.has(`${baseKey}_${suffix}`)) {
    suffix += 1;
  }

  return `${baseKey}_${suffix}`;
}

export async function loadFieldCatalogByKey(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    eventTypeConfigId: Id<"eventTypeConfigs">;
  },
): Promise<Map<string, Doc<"eventTypeFieldCatalog">>> {
  const entries = new Map<string, Doc<"eventTypeFieldCatalog">>();
  const rows = ctx.db
    .query("eventTypeFieldCatalog")
    .withIndex("by_tenantId_and_eventTypeConfigId", (q) =>
      q
        .eq("tenantId", args.tenantId)
        .eq("eventTypeConfigId", args.eventTypeConfigId),
    );

  for await (const row of rows) {
    entries.set(row.fieldKey, row);
  }

  return entries;
}

export async function upsertEventTypeFieldCatalogEntry(
  ctx: MutationCtx,
  args: {
    existingEntriesByFieldKey: Map<string, Doc<"eventTypeFieldCatalog">>;
    tenantId: Id<"tenants">;
    eventTypeConfigId: Id<"eventTypeConfigs">;
    fieldKey: string;
    currentLabel: string;
    seenAt: number;
    valueType?: string;
  },
): Promise<{
  action: "created" | "updated" | "unchanged";
  fieldCatalogId: Id<"eventTypeFieldCatalog">;
}> {
  const existing = args.existingEntriesByFieldKey.get(args.fieldKey) ?? null;

  if (existing) {
    const patch: Partial<Doc<"eventTypeFieldCatalog">> = {};
    if (args.seenAt > existing.lastSeenAt) {
      patch.lastSeenAt = args.seenAt;
      patch.currentLabel = args.currentLabel;
    } else if (existing.currentLabel !== args.currentLabel) {
      patch.currentLabel = args.currentLabel;
    }
    if (args.valueType && existing.valueType !== args.valueType) {
      patch.valueType = args.valueType;
    }

    if (Object.keys(patch).length > 0) {
      const updated = {
        ...existing,
        ...patch,
      };
      await ctx.db.patch(existing._id, patch);
      args.existingEntriesByFieldKey.set(updated.fieldKey, updated);
      return {
        action: "updated",
        fieldCatalogId: existing._id,
      };
    }

    return {
      action: "unchanged",
      fieldCatalogId: existing._id,
    };
  }

  const insertValue: Omit<
    Doc<"eventTypeFieldCatalog">,
    "_creationTime" | "_id"
  > = {
    tenantId: args.tenantId,
    eventTypeConfigId: args.eventTypeConfigId,
    fieldKey: args.fieldKey,
    currentLabel: args.currentLabel,
    firstSeenAt: args.seenAt,
    lastSeenAt: args.seenAt,
  };
  if (args.valueType) {
    insertValue.valueType = args.valueType;
  }
  const fieldCatalogId = await ctx.db.insert(
    "eventTypeFieldCatalog",
    insertValue,
  );

  args.existingEntriesByFieldKey.set(args.fieldKey, {
    _id: fieldCatalogId,
    _creationTime: args.seenAt,
    ...insertValue,
  });

  return {
    action: "created",
    fieldCatalogId,
  };
}
