import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { getConvexSize, type Value } from "convex/values";
import type {
  ReportContribution,
  ReportResultWrite,
  ScalarRecord,
} from "./contracts";
import {
  REPORT_MAX_CHECKPOINT_BYTES,
  REPORT_MAX_COMMIT_AFFECTED_ROWS,
  REPORT_MAX_COMMIT_CONTRIBUTIONS,
} from "./contracts";

type ReportMutationCtx = MutationCtx;
type ReportReadCtx = QueryCtx | MutationCtx;

export const DEDUPE_SECTION = "__dedupe__";

export function assertBatchSize(items: readonly unknown[], label: string) {
  if (items.length > REPORT_MAX_COMMIT_CONTRIBUTIONS) {
    throw new Error(
      `${label} cannot contain more than ${REPORT_MAX_COMMIT_CONTRIBUTIONS} items.`,
    );
  }
}

export function assertNonNegativeInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
}

export function assertSafeStorageKey(value: string, label: string) {
  if (
    value.length < 1 ||
    value.length > 500 ||
    value.startsWith("$") ||
    value.startsWith("_") ||
    !/^[\x20-\x7E]+$/.test(value)
  ) {
    throw new Error(`${label} is not a valid report record key.`);
  }
}

export function assertBoundedStorageIdentifier(
  value: string,
  label: string,
  maxLength = 500,
) {
  if (
    value.length < 1 ||
    value.length > maxLength ||
    !/^[\x20-\x7E]+$/.test(value)
  ) {
    throw new Error(`${label} is invalid.`);
  }
}

export async function getJobCheckpoint(
  ctx: ReportReadCtx,
  jobId: Id<"operationsReportJobs">,
  sourceKey: string,
) {
  return await ctx.db
    .query("operationsReportCheckpoints")
    .withIndex("by_jobId_and_sourceKey", (q) =>
      q.eq("jobId", jobId).eq("sourceKey", sourceKey),
    )
    .unique();
}

export function hasActiveLease(
  job: Doc<"operationsReportJobs">,
  args: { workerId: string; leaseGeneration: number; now: number },
) {
  return (
    (job.status === "running" || job.status === "rendering") &&
    job.leaseOwner === args.workerId &&
    job.leaseGeneration === args.leaseGeneration &&
    job.leaseExpiresAt !== undefined &&
    job.leaseExpiresAt > args.now
  );
}

export async function ownerCanRunReport(
  ctx: ReportReadCtx,
  job: Doc<"operationsReportJobs">,
) {
  const user = await ctx.db.get(job.requestedByUserId);
  return Boolean(
    user &&
      user.tenantId === job.tenantId &&
      user.isActive &&
      (user.role === "tenant_master" || user.role === "tenant_admin"),
  );
}

export async function applyReportContributions(
  ctx: ReportMutationCtx,
  job: Doc<"operationsReportJobs">,
  contributions: ReportContribution[],
  now: number,
) {
  assertBatchSize(contributions, "Report contribution batch");
  if (getConvexSize(contributions as Value) > REPORT_MAX_CHECKPOINT_BYTES) {
    throw new Error("Report contribution batch exceeds the 1 MiB checkpoint budget.");
  }

  const affectedKeys = new Set<string>();
  for (const contribution of contributions) {
    affectedKeys.add(`${contribution.section}\u0000${contribution.rowKey}`);
    if (contribution.operation === "uniqueSum") {
      affectedKeys.add(
        `${DEDUPE_SECTION}\u0000${contribution.section}\u001f${contribution.rowKey}\u001f${contribution.field}\u001f${contribution.dedupeKey}`,
      );
    }
  }
  if (affectedKeys.size > REPORT_MAX_COMMIT_AFFECTED_ROWS) {
    throw new Error(
      `Report checkpoint affects more than ${REPORT_MAX_COMMIT_AFFECTED_ROWS} rows.`,
    );
  }

  const grouped = new Map<
    string,
    { section: string; rowKey: string; contributions: ReportContribution[] }
  >();

  for (const contribution of contributions) {
    assertBoundedStorageIdentifier(contribution.section, "Contribution section", 200);
    assertBoundedStorageIdentifier(
      contribution.rowKey,
      "Contribution row key",
      2_048,
    );
    assertSafeStorageKey(contribution.field, "Contribution field");
    const groupKey = `${contribution.section}\u0000${contribution.rowKey}`;
    const group = grouped.get(groupKey) ?? {
      section: contribution.section,
      rowKey: contribution.rowKey,
      contributions: [],
    };

    if (contribution.operation === "uniqueSum") {
      assertBoundedStorageIdentifier(contribution.dedupeKey, "Contribution dedupe key");
      const dedupeRowKey = [
        contribution.section,
        contribution.rowKey,
        contribution.field,
        contribution.dedupeKey,
      ].join("\u001f");
      const existingDedupe = await ctx.db
        .query("operationsReportRows")
        .withIndex("by_jobId_and_section_and_rowKey", (q) =>
          q
            .eq("jobId", job._id)
            .eq("section", DEDUPE_SECTION)
            .eq("rowKey", dedupeRowKey),
        )
        .unique();
      if (existingDedupe) {
        continue;
      }
      await ctx.db.insert("operationsReportRows", {
        tenantId: job.tenantId,
        jobId: job._id,
        rowType: "dedupe",
        section: DEDUPE_SECTION,
        rowKey: dedupeRowKey,
        payload: { seen: true },
        updatedAt: now,
      });
      group.contributions.push({
        section: contribution.section,
        rowKey: contribution.rowKey,
        field: contribution.field,
        operation: "sum",
        value: contribution.value,
      });
    } else {
      group.contributions.push(contribution);
    }
    grouped.set(groupKey, group);
  }

  for (const group of grouped.values()) {
    if (group.contributions.length === 0) {
      continue;
    }
    const existing = await ctx.db
      .query("operationsReportRows")
      .withIndex("by_jobId_and_section_and_rowKey", (q) =>
        q
          .eq("jobId", job._id)
          .eq("section", group.section)
          .eq("rowKey", group.rowKey),
      )
      .unique();
    const payload: ScalarRecord = { ...(existing?.payload ?? {}) };

    for (const contribution of group.contributions) {
      const current = payload[contribution.field];
      switch (contribution.operation) {
        case "sum": {
          if (current !== undefined && typeof current !== "number") {
            throw new Error("Cannot add to a non-numeric report field.");
          }
          payload[contribution.field] = (current ?? 0) + contribution.value;
          break;
        }
        case "max": {
          if (current !== undefined && typeof current !== "number") {
            throw new Error("Cannot compare a non-numeric report field.");
          }
          payload[contribution.field] =
            current === undefined
              ? contribution.value
              : Math.max(current, contribution.value);
          break;
        }
        case "set":
          payload[contribution.field] = contribution.value;
          break;
        case "uniqueSum":
          throw new Error("Unique contributions must be normalized first.");
      }
    }

    if (existing) {
      await ctx.db.patch(existing._id, {
        rowType: "staging",
        payload,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("operationsReportRows", {
        tenantId: job.tenantId,
        jobId: job._id,
        rowType: "staging",
        section: group.section,
        rowKey: group.rowKey,
        payload,
        updatedAt: now,
      });
    }
  }
}

export async function applyFinalizedRows(
  ctx: ReportMutationCtx,
  job: Doc<"operationsReportJobs">,
  rows: ReportResultWrite[],
  now: number,
) {
  assertBatchSize(rows, "Finalized result batch");
  if (rows.length > REPORT_MAX_COMMIT_AFFECTED_ROWS) {
    throw new Error(
      `Finalized result batch cannot affect more than ${REPORT_MAX_COMMIT_AFFECTED_ROWS} rows.`,
    );
  }
  if (getConvexSize(rows as Value) > REPORT_MAX_CHECKPOINT_BYTES) {
    throw new Error("Finalized result batch exceeds the 1 MiB checkpoint budget.");
  }
  for (const row of rows) {
    assertBoundedStorageIdentifier(row.section, "Result section", 200);
    assertBoundedStorageIdentifier(row.rowKey, "Result row key", 2_048);
    if (row.groupKey !== undefined) {
      assertBoundedStorageIdentifier(row.groupKey, "Result group key");
    }
    for (const field of Object.keys(row.payload)) {
      assertSafeStorageKey(field, "Result field");
    }
    const existing = await ctx.db
      .query("operationsReportRows")
      .withIndex("by_jobId_and_section_and_rowKey", (q) =>
        q
          .eq("jobId", job._id)
          .eq("section", row.section)
          .eq("rowKey", row.rowKey),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        rowType: "result",
        groupKey: row.groupKey,
        payload: row.payload,
        sortValue: row.sortValue,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("operationsReportRows", {
        tenantId: job.tenantId,
        jobId: job._id,
        rowType: "result",
        section: row.section,
        rowKey: row.rowKey,
        groupKey: row.groupKey,
        payload: row.payload,
        sortValue: row.sortValue,
        updatedAt: now,
      });
    }
  }
}
