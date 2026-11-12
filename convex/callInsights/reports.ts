import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { categoryLabel, ITEM_KINDS } from "../../lib/callInsights/taxonomy";
import {
  insightsViewer,
  VIEWER_ROLES,
  type CallHeader,
  type ItemFact,
} from "./access";

const categoryCounts = {
  category: v.string(),
  label: v.string(),
  calls: v.number(),
};

export const summaryValidator = v.union(
  v.null(),
  v.object({
    coverage: v.object({
      matched: v.number(),
      read: v.number(),
      waiting: v.number(),
      failed: v.number(),
      skippedByReason: v.record(v.string(), v.number()),
    }),
    objections: v.array(
      v.object({
        ...categoryCounts,
        primaryCalls: v.number(),
        resolved: v.number(),
        unresolved: v.number(),
        unknown: v.number(),
      }),
    ),
    struggles: v.array(v.object(categoryCounts)),
    goals: v.array(v.object(categoryCounts)),
    incomeBands: v.array(
      v.object({
        kind: v.string(),
        label: v.string(),
        band: v.string(),
        calls: v.number(),
      }),
    ),
    noShowTiers: v.record(v.string(), v.number()),
    capped: v.boolean(),
  }),
);

export const summary = query({
  args: { days: v.union(v.literal(30), v.literal(90)) },
  returns: summaryValidator,
  handler: async (ctx, args) => {
    const actor = await requireTenantUser(ctx, [...VIEWER_ROLES]);
    const viewer = await insightsViewer(ctx, actor);
    if (!viewer?.isAdmin) return null;
    const now = Date.now(),
      since = now - args.days * 86_400_000;
    const headerRows = await ctx.db
      .query("callInsightFacts")
      .withIndex("by_tenantId_and_kind_and_scheduledAt", (q) =>
        q
          .eq("tenantId", actor.tenantId)
          .eq("kind", "call")
          .gte("scheduledAt", since)
          .lte("scheduledAt", now),
      )
      .order("desc")
      .take(1000);
    const groups = await Promise.all(
      ITEM_KINDS.map((kind) =>
        ctx.db
          .query("callInsightFacts")
          .withIndex("by_tenantId_and_kind_and_scheduledAt", (q) =>
            q
              .eq("tenantId", actor.tenantId)
              .eq("kind", kind)
              .gte("scheduledAt", since)
              .lte("scheduledAt", now),
          )
          .order("desc")
          .take(4000),
      ),
    );
    const capped =
      headerRows.length === 1000 || groups.some((rows) => rows.length === 4000);
    const headers = headerRows.filter(
      (row): row is CallHeader => row.kind === "call" && row.active,
    );
    const byRecording = new Map<string, ItemFact[]>();
    for (const row of groups.flat()) {
      if (row.kind === "call") continue;
      const rows = byRecording.get(row.recordingId) ?? [];
      rows.push(row);
      byRecording.set(row.recordingId, rows);
    }
    const coverage = {
      matched: headers.length,
      read: 0,
      waiting: 0,
      failed: 0,
      skippedByReason: {} as Record<string, number>,
    };
    const noShowTiers: Record<string, number> = {};
    const objections = new Map<
      string,
      {
        category: string;
        label: string;
        calls: number;
        primaryCalls: number;
        resolved: number;
        unresolved: number;
        unknown: number;
      }
    >();
    const struggles = new Map<
      string,
      { category: string; label: string; calls: number }
    >();
    const goals = new Map<
      string,
      { category: string; label: string; calls: number }
    >();
    const incomeBands = new Map<
      string,
      { kind: string; label: string; band: string; calls: number }
    >();
    for (const header of headers) {
      if (header.latestStatus === "waiting") coverage.waiting++;
      if (header.latestStatus === "failed") coverage.failed++;
      if (header.latestStatus === "skipped") {
        const reason = header.reasonCode ?? "unknown";
        coverage.skippedByReason[reason] =
          (coverage.skippedByReason[reason] ?? 0) + 1;
      }
      if (header.noShowTier)
        noShowTiers[header.noShowTier] =
          (noShowTiers[header.noShowTier] ?? 0) + 1;
      const current = (byRecording.get(header.recordingId) ?? []).filter(
        (row) =>
          row.meetingId === header.meetingId &&
          row.publicationRevision === header.publicationRevision,
      );
      if (!header.publishedRunId || current.length !== header.expectedItemCount)
        continue;
      coverage.read++;
      const accepted = current.filter(
        (row) => row.check === "confirmed" || row.check === "restored",
      );
      const categories = new Map<string, ItemFact[]>();
      for (const row of accepted) {
        const key = `${row.kind}:${row.category}`;
        categories.set(key, [...(categories.get(key) ?? []), row]);
      }
      for (const rows of categories.values()) {
        const first = rows[0],
          category = first.category;
        if (first.kind === "objection") {
          const count = objections.get(category) ?? {
            category,
            label: categoryLabel("objection", category),
            calls: 0,
            primaryCalls: 0,
            resolved: 0,
            unresolved: 0,
            unknown: 0,
          };
          count.calls++;
          if (rows.some((row) => row.isPrimary)) count.primaryCalls++;
          const resolution = rows.some((row) => row.resolution === "unresolved")
            ? "unresolved"
            : rows.some((row) => row.resolution !== "resolved")
              ? "unknown"
              : "resolved";
          count[resolution]++;
          objections.set(category, count);
        } else if (first.kind === "struggle" || first.kind === "goal") {
          const map = first.kind === "struggle" ? struggles : goals;
          const count = map.get(category) ?? {
            category,
            label: categoryLabel(first.kind, category),
            calls: 0,
          };
          count.calls++;
          map.set(category, count);
        } else if (first.kind === "income") {
          const currentIncome = rows.filter(
            (row) => row.scenario === "current",
          );
          if (currentIncome.length === 0) continue;
          const bands = new Set(
            currentIncome.map((row) => row.band ?? "no_monthly_equivalent"),
          );
          const band = bands.size > 1 ? "spans_bands" : [...bands][0];
          const key = `${category}:${band}`;
          const count = incomeBands.get(key) ?? {
            kind: category,
            label: categoryLabel("income", category),
            band,
            calls: 0,
          };
          count.calls++;
          incomeBands.set(key, count);
        }
      }
    }
    const ranked = <T extends { calls: number }>(rows: Iterable<T>) =>
      [...rows].sort((a, b) => b.calls - a.calls);
    return {
      coverage,
      objections: ranked(objections.values()),
      struggles: ranked(struggles.values()),
      goals: ranked(goals.values()),
      incomeBands: ranked(incomeBands.values()),
      noShowTiers,
      capped,
    };
  },
});
