import { v } from "convex/values";
import { z } from "zod";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { headerFor } from "../callInsights/trigger";
import { fathomFetch, FathomRetry, rosterPage, rosterFields } from "./client";
import { reportError, log } from "../lib/observability/log";
import {
  businessDateForInstant,
  businessDayRange,
} from "../../lib/businessDay";
import { getTenantBusinessDay } from "../lib/tenantBusinessDay";

/**
 * Call insights keeps the prospect's words only as long as the transcript.
 * A recording it never read has nothing to delete, so nothing is scheduled.
 */
async function purgeInsightsWithTranscript(ctx: MutationCtx, recordingId: Id<"callRecordings">) {
  try {
    if (!(await headerFor(ctx, recordingId))) return;
    await ctx.scheduler.runAfter(0, internal.callInsights.maintenance.purgeRecording, {
      recordingId,
    });
  } catch (error) {
    // The transcript purge must finish whatever happens here.
    reportError("call_insights.purge_hook_failed", error, { recordingId, severity: "warning" });
  }
}

const cursor = v.union(v.string(), v.null());
export const sweep = internalMutation({
  args: { cursor: v.optional(cursor) },
  returns: v.null(),
  handler: async (ctx, a) => {
    const page = await ctx.db
      .query("tenantFathomConnections")
      .withIndex("by_connectionStatus", (q) =>
        q.eq("connectionStatus", "connected"),
      )
      .paginate({ cursor: a.cursor ?? null, numItems: 20 });
    for (const c of page.page) {
      await ctx.scheduler.runAfter(0, internal.fathom.maintenance.syncRoster, {
        connectionId: c._id,
        kind: "team_members",
        cursor: null,
      });
      await ctx.scheduler.runAfter(0, internal.fathom.maintenance.syncRoster, {
        connectionId: c._id,
        kind: "users",
        cursor: null,
      });
      await ctx.scheduler.runAfter(
        0,
        internal.fathom.maintenance.startReconcile,
        {
          connectionId: c._id,
          since: (c.lastReconciledAt ?? Date.now() - 86400_000) - 2 * 3600_000,
        },
      );
      await ctx.scheduler.runAfter(0, internal.fathom.maintenance.health, {
        connectionId: c._id,
        cursor: null,
        warnings: [],
      });
    }
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, internal.fathom.maintenance.sweep, {
        cursor: page.continueCursor,
      });
    log.info("fathom.maintenance.batch", {
      count: page.page.length,
      continued: !page.isDone,
    });
    return null;
  },
});
export const syncRoster = internalAction({
  args: {
    connectionId: v.id("tenantFathomConnections"),
    kind: v.union(v.literal("team_members"), v.literal("users")),
    cursor,
    attempt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    const c = await ctx.runQuery(internal.fathom.state.connection, {
      connectionId: a.connectionId,
    });
    if (!c || c.connectionStatus !== "connected") return null;
    try {
      const response = await fathomFetch(
        ctx,
        c._id,
        c.apiKey,
        `/${a.kind}${a.cursor ? `?cursor=${encodeURIComponent(a.cursor)}` : ""}`,
        {},
        a.kind === "users" ? [403] : [],
      );
      if (response.status === 403) {
        await ctx.runMutation(internal.fathom.state.syncMembers, {
          connectionId: c._id,
          members: [],
          accountAdmin: false,
        });
        return null;
      }
      const page = rosterPage.parse(await response.json());
      await ctx.runMutation(internal.fathom.state.syncMembers, {
        connectionId: c._id,
        members: rosterFields(page),
        ...(a.kind === "users" ? { accountAdmin: true } : {}),
      });
      if (page.next_cursor)
        await ctx.scheduler.runAfter(
          2100,
          internal.fathom.maintenance.syncRoster,
          { ...a, attempt: 0, cursor: page.next_cursor },
        );
    } catch (error) {
      reportError(
        "fathom.roster.failed",
        new Error("Fathom roster sync failed"),
        { connectionId: c._id, integration: "fathom" },
      );
      if ((a.attempt ?? 0) < 5)
        await ctx.scheduler.runAfter(
          error instanceof FathomRetry ? error.delayMs : 60_000,
          internal.fathom.maintenance.syncRoster,
          { ...a, attempt: (a.attempt ?? 0) + 1 },
        );
    }
    return null;
  },
});
export const startReconcile = internalMutation({
  args: { connectionId: v.id("tenantFathomConnections"), since: v.number() },
  returns: v.null(),
  handler: async (ctx, a) => {
    const c = await ctx.db.get("tenantFathomConnections", a.connectionId);
    if (
      !c ||
      c.connectionStatus !== "connected" ||
      (c.reconcileUntil ?? 0) > Date.now()
    )
      return null;
    const token = `${Date.now()}:${c._id}`;
    await ctx.db.patch("tenantFathomConnections", c._id, {
      reconcileToken: token,
      reconcileUntil: Date.now() + 3600_000,
    });
    await ctx.scheduler.runAfter(0, internal.fathom.maintenance.reconcile, {
      connectionId: c._id,
      token,
      since: a.since,
      startedAt: Date.now(),
      memberCursor: null,
      apiCursor: null,
      emails: [],
      attempt: 0,
    });
    return null;
  },
});
export const linkedMembers = internalQuery({
  args: { connectionId: v.id("tenantFathomConnections"), cursor },
  returns: v.object({
    emails: v.array(v.string()),
    cursor: v.string(),
    done: v.boolean(),
  }),
  handler: async (ctx, a) => {
    const c = await ctx.db.get("tenantFathomConnections", a.connectionId);
    if (!c) return { emails: [], cursor: "", done: true };
    const page = await ctx.db
      .query("fathomOrgMembers")
      .withIndex("by_tenantId_and_email", (q) => q.eq("tenantId", c.tenantId))
      .paginate({ cursor: a.cursor, numItems: 50 });
    const emails: string[] = [];
    for (const m of page.page) {
      if (!m.ignored && m.matchedUserId) {
        const user = await ctx.db.get("users", m.matchedUserId);
        if (user?.isActive && user.tenantId === c.tenantId)
          emails.push(m.email);
      }
    }
    return { emails, cursor: page.continueCursor, done: page.isDone };
  },
});
export const reconcileCheckpoint = internalMutation({
  args: {
    connectionId: v.id("tenantFathomConnections"),
    token: v.string(),
    completedAt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    const c = await ctx.db.get("tenantFathomConnections", a.connectionId);
    if (c?.reconcileToken === a.token)
      await ctx.db.patch(
        "tenantFathomConnections",
        c._id,
        a.completedAt
          ? {
              reconcileToken: undefined,
              reconcileUntil: undefined,
              lastReconciledAt: a.completedAt,
              lastError: undefined,
            }
          : { reconcileUntil: Date.now() + 3600_000 },
      );
    return null;
  },
});
const reconcileArgs = {
  connectionId: v.id("tenantFathomConnections"),
  token: v.string(),
  since: v.number(),
  startedAt: v.number(),
  memberCursor: cursor,
  apiCursor: cursor,
  emails: v.array(v.string()),
  nextMemberCursor: v.optional(cursor),
  attempt: v.number(),
};
export const reconcile = internalAction({
  args: reconcileArgs,
  returns: v.null(),
  handler: async (ctx, a) => {
    const c = await ctx.runQuery(internal.fathom.state.connection, {
      connectionId: a.connectionId,
    });
    if (
      !c ||
      c.connectionStatus !== "connected" ||
      c.reconcileToken !== a.token
    )
      return null;
    try {
      await ctx.runMutation(internal.fathom.maintenance.reconcileCheckpoint, {
        connectionId: c._id,
        token: a.token,
      });
      let emails = a.emails,
        nextMemberCursor = a.nextMemberCursor;
      if (!a.apiCursor) {
        const members = await ctx.runQuery(
          internal.fathom.maintenance.linkedMembers,
          { connectionId: c._id, cursor: a.memberCursor },
        );
        emails = members.emails;
        nextMemberCursor = members.done ? null : members.cursor;
      }
      let nextApiCursor: string | null = null;
      if (emails.length) {
        // The list carries each recording's transcript, summary and action items, so one request
        // covers a page instead of two more per recording; the processor fetches only what's missing.
        // Repeated recorded_by[], created_after and the include flags are documented at
        // https://developers.fathom.ai/api-reference/meetings/list-meetings.
        const params = new URLSearchParams({
          created_after: new Date(a.since).toISOString(),
          include_transcript: "true",
          include_summary: "true",
          include_action_items: "true",
        });
        for (const email of emails) params.append("recorded_by[]", email);
        if (a.apiCursor) params.set("cursor", a.apiCursor);
        const response = await fathomFetch(
          ctx,
          c._id,
          c.apiKey,
          `/meetings?${params}`,
        );
        const page = z
          .object({
            items: z
              .array(z.object({ recording_id: z.number().int() }).passthrough())
              .max(200),
            next_cursor: z.string().nullable(),
          })
          .parse(await response.json());
        nextApiCursor = page.next_cursor;
        for (const item of page.items) {
          if (
            await ctx.runQuery(internal.fathom.processor.exists, {
              tenantId: c.tenantId,
              fathomRecordingId: item.recording_id,
            })
          )
            continue;
          const storageId = await ctx.storage.store(
            new Blob([JSON.stringify(item)], { type: "application/json" }),
          );
          const used = await ctx.runMutation(internal.fathom.processor.ingest, {
            connectionId: c._id,
            webhookMessageId: `reconcile:${item.recording_id}`,
            payloadStorageId: storageId,
          });
          if (!used) await ctx.storage.delete(storageId);
        }
      }
      if (nextApiCursor || nextMemberCursor)
        await ctx.scheduler.runAfter(
          2100,
          internal.fathom.maintenance.reconcile,
          {
            ...a,
            attempt: 0,
            memberCursor: nextApiCursor
              ? a.memberCursor
              : (nextMemberCursor ?? null),
            apiCursor: nextApiCursor,
            emails,
            nextMemberCursor,
          },
        );
      else
        await ctx.runMutation(internal.fathom.maintenance.reconcileCheckpoint, {
          connectionId: c._id,
          token: a.token,
          completedAt: a.startedAt,
        });
    } catch (error) {
      reportError(
        "fathom.reconcile.failed",
        new Error("Fathom reconciliation failed"),
        { connectionId: c._id, integration: "fathom" },
      );
      if (a.attempt < 8)
        await ctx.scheduler.runAfter(
          error instanceof FathomRetry ? error.delayMs : 60_000,
          internal.fathom.maintenance.reconcile,
          { ...a, attempt: a.attempt + 1 },
        );
    }
    return null;
  },
});
export const deleteWebhook = internalAction({
  args: {
    connectionId: v.id("tenantFathomConnections"),
    apiKey: v.string(),
    webhookId: v.string(),
    attempt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    try {
      await fathomFetch(
        ctx,
        a.connectionId,
        a.apiKey,
        `/webhooks/${encodeURIComponent(a.webhookId)}`,
        { method: "DELETE" },
        [404],
      );
    } catch (error) {
      reportError(
        "fathom.webhook.delete_failed",
        new Error("Fathom old webhook deletion failed"),
        { connectionId: a.connectionId, integration: "fathom" },
      );
      if (a.attempt < 8)
        await ctx.scheduler.runAfter(
          error instanceof FathomRetry ? error.delayMs : 60_000,
          internal.fathom.maintenance.deleteWebhook,
          { ...a, attempt: a.attempt + 1 },
        );
    }
    return null;
  },
});
export const health = internalMutation({
  args: {
    connectionId: v.id("tenantFathomConnections"),
    cursor,
    warnings: v.array(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    const c = await ctx.db.get("tenantFathomConnections", a.connectionId);
    if (!c || c.connectionStatus !== "connected") return null;
    const setting = await getTenantBusinessDay(ctx, c.tenantId);
    const { start, end } = businessDayRange(
      businessDateForInstant(Date.now(), setting),
      setting,
    );
    const page = await ctx.db
      .query("users")
      .withIndex("by_tenantId_and_isActive", (q) =>
        q.eq("tenantId", c.tenantId).eq("isActive", true),
      )
      .paginate({ cursor: a.cursor, numItems: 10 });
    const warnings = a.warnings;
    for (const u of page.page) {
      if (u.role !== "closer") continue;
      const meetings = await ctx.db
        .query("meetings")
        .withIndex("by_tenantId_and_assignedCloserId_and_scheduledAt", (q) =>
          q
            .eq("tenantId", c.tenantId)
            .eq("assignedCloserId", u._id)
            .gte("scheduledAt", start)
            .lt("scheduledAt", Math.min(end, Date.now())),
        )
        .take(100);
      let missing = 0;
      for (const m of meetings)
        if (
          m.status !== "canceled" &&
          !(await ctx.db
            .query("callRecordings")
            .withIndex("by_meetingId", (q) => q.eq("meetingId", m._id))
            .first())
        )
          missing++;
      if (missing >= 3 && warnings.length < 100)
        warnings.push(
          `${u.fullName ?? "A closer"} has ${missing}${meetings.length === 100 ? "+" : ""} calls that started this business day without a recording. Check sharing settings and whether the bot joined.`,
        );
    }
    if (!page.isDone && warnings.length < 100)
      await ctx.scheduler.runAfter(0, internal.fathom.maintenance.health, {
        ...a,
        warnings,
        cursor: page.continueCursor,
      });
    else
      await ctx.db.patch("tenantFathomConnections", c._id, {
        healthWarnings: warnings,
      });
    return null;
  },
});
export const purge = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    let more = false,
      deleted = 0,
      transcripts = 0;
    for (const status of [
      "pending",
      "processed",
      "dropped",
      "failed",
    ] as const) {
      const rows = await ctx.db
        .query("fathomWebhookEvents")
        .withIndex("by_status_and_receivedAt", (q) =>
          q.eq("status", status).lt("receivedAt", Date.now() - 7 * 86400_000),
        )
        .take(25);
      for (const row of rows) {
        if (row.payloadStorageId)
          await ctx.storage.delete(row.payloadStorageId);
        await ctx.db.delete("fathomWebhookEvents", row._id);
        deleted++;
      }
      more ||= rows.length === 25;
    }
    const held = await ctx.db
      .query("fathomWebhookEvents")
      .withIndex("by_status_and_holdUntil", (q) =>
        q.eq("status", "held").lte("holdUntil", Date.now()),
      )
      .take(25);
    for (const row of held) {
      if (row.payloadStorageId) await ctx.storage.delete(row.payloadStorageId);
      await ctx.db.delete("fathomWebhookEvents", row._id);
      deleted++;
    }
    more ||= held.length === 25;
    const recordings = await ctx.db
      .query("callRecordings")
      .withIndex("by_transcriptExpiresAt", (q) =>
        q.gt("transcriptExpiresAt", 0).lte("transcriptExpiresAt", Date.now()),
      )
      .take(25);
    for (const row of recordings) {
      if (row.transcriptStorageId)
        await ctx.storage.delete(row.transcriptStorageId);
      await ctx.db.patch("callRecordings", row._id, {
        transcriptStorageId: undefined,
        transcriptDeletedAt: Date.now(),
        transcriptExpiresAt: undefined,
      });
      await purgeInsightsWithTranscript(ctx, row._id);
      transcripts++;
    }
    more ||= recordings.length === 25;
    // Compatibility with the base schema: old rows may lack transcriptExpiresAt.
    // This bounded fallback makes progress by setting transcriptDeletedAt even when no file remains.
    const legacy = await ctx.db
      .query("callRecordings")
      .withIndex("by_transcriptDeletedAt_and_createdAt", (q) =>
        q
          .eq("transcriptDeletedAt", undefined)
          .lt("createdAt", Date.now() - 90 * 86400_000),
      )
      .take(25);
    for (const row of legacy) {
      if (row.transcriptStorageId)
        await ctx.storage.delete(row.transcriptStorageId);
      await ctx.db.patch("callRecordings", row._id, {
        transcriptStorageId: undefined,
        transcriptDeletedAt: Date.now(),
        transcriptExpiresAt: undefined,
      });
      await purgeInsightsWithTranscript(ctx, row._id);
      transcripts++;
    }
    more ||= legacy.length === 25;
    if (more)
      await ctx.scheduler.runAfter(0, internal.fathom.maintenance.purge, {});
    log.info("fathom.purge.batch", {
      deletedEvents: deleted,
      transcripts,
      continued: more,
    });
    return null;
  },
});
