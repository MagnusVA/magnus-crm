import { v } from "convex/values";
import type { Id } from "../../../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../../../_generated/server";
import { checkLinkMemberAllowed, linkMemberCore } from "../../../fathom/connection";
import { attachRecordingCore } from "../../../fathom/recordings";
import { retryDeliveryCore } from "../../../pipeline/recovery";
import { retryProjectionCore } from "../../../operations/workStatus";
import { rejectRequest } from "../../../lib/observability/errors";
import type { CheckResult } from "../../../lib/outcomeCores";
import { mcpCallerValidator, requireMcpAdmin, loadInTenant } from "../../guard";
import { formatLocal } from "../../time";
import { appLink, prepareSingle, type AdminActor, type Committer, type Pins } from "../prepare";
import { actorOf, asAgentError, ok } from "./common";

/**
 * `magnus_repair` (docs/plans/admin-assistant.md §2, tool 16): one named
 * repair. Retries carry the generation the agent saw, so a retry that raced
 * another one is refused as stale instead of running twice.
 */

type RepairAction =
  | { kind: "retry_delivery"; deliveryId: Id<"webhookDeliveries">; generation: number }
  | { kind: "retry_projection"; projection: "meeting" | "opportunity"; id: string; generation: number }
  | { kind: "link_fathom_recorder"; memberId: Id<"fathomOrgMembers">; userId?: Id<"users">; ignored?: boolean }
  | { kind: "attach_recording"; recordingId: Id<"callRecordings">; meetingId?: Id<"meetings">; notASalesCall?: boolean };

type RepairArgs = { action: RepairAction };

async function pins(ctx: MutationCtx, actor: AdminActor, { action: a }: RepairArgs): Promise<Pins> {
  switch (a.kind) {
    case "retry_delivery": {
      const row = await ctx.db.get("webhookDeliveries", a.deliveryId);
      if (!row || row.tenantId !== actor.tenantId) return { delivery: "missing" };
      return { "delivery.status": row.status, "delivery.generation": row.generation };
    }
    case "retry_projection": {
      const table = a.projection === "meeting" ? "meetingProjections" : "opportunityProjectionJobs";
      const id = ctx.db.normalizeId(table, a.id);
      const row = id ? await ctx.db.get(table, id as never) : null;
      if (!row || (row as { tenantId: Id<"tenants"> }).tenantId !== actor.tenantId) return { projection: "missing" };
      const r = row as { status: string; generation: number };
      return { "projection.status": r.status, "projection.generation": r.generation };
    }
    case "link_fathom_recorder": {
      const m = await ctx.db.get("fathomOrgMembers", a.memberId);
      if (!m || m.tenantId !== actor.tenantId) return { member: "missing" };
      return { "member.matchedUserId": m.matchedUserId ?? null, "member.ignored": m.ignored };
    }
    case "attach_recording": {
      const r = await ctx.db.get("callRecordings", a.recordingId);
      if (!r || r.tenantId !== actor.tenantId) return { recording: "missing" };
      const out: Pins = { "recording.matchStatus": r.matchStatus, "recording.meetingId": r.meetingId ?? null };
      if (a.meetingId) {
        const taken = await ctx.db
          .query("callRecordings")
          .withIndex("by_meetingId", (q) => q.eq("meetingId", a.meetingId))
          .first();
        out["meeting.recordingId"] = taken?._id ?? null;
      }
      return out;
    }
  }
}

async function check(ctx: MutationCtx, actor: AdminActor, { action: a }: RepairArgs): Promise<CheckResult<object>> {
  switch (a.kind) {
    case "retry_delivery":
    case "retry_projection":
      // Pins cover status and generation; the core re-checks both on apply.
      return ok;
    case "link_fathom_recorder":
      return (await checkLinkMemberAllowed(ctx, actor, a)) as CheckResult<object>;
    case "attach_recording":
      if (Boolean(a.meetingId) === Boolean(a.notASalesCall))
        return { ok: false, code: "fathom.invalid_assignment", message: "Choose a meeting or Not a sales call." };
      return ok;
  }
}

export const repairCommitter: Committer<RepairArgs> = {
  tool: "magnus_repair",
  family: "repairs",
  kind: "single",
  permission: "settings:manage",
  pins: (ctx, actor, args) => pins(ctx as MutationCtx, actor, args),
  check: (ctx, actor, args) => check(ctx as MutationCtx, actor, args),
  apply: async (ctx, actor, { action: a }, provenance) => {
    const mctx = ctx as MutationCtx;
    switch (a.kind) {
      case "retry_delivery":
        await asAgentError(() => retryDeliveryCore(mctx, actor, { deliveryId: a.deliveryId, generation: a.generation }, provenance));
        return { delivery: "queued", note: "The retry is queued. Ask magnus_health later for its outcome." };
      case "retry_projection":
        await asAgentError(() => retryProjectionCore(mctx, actor, { kind: a.projection, id: a.id, generation: a.generation }, provenance));
        return { projection: "queued", note: "The rebuild is queued. Ask magnus_health later for its outcome." };
      case "link_fathom_recorder":
        await asAgentError(() =>
          linkMemberCore(mctx, actor, { memberId: a.memberId, ...(a.userId ? { userId: a.userId } : {}), ...(a.ignored ? { ignored: true } : {}) }, provenance),
        );
        return { member: a.ignored ? "ignored" : "linked", note: "Held recordings from this person are matched again." };
      case "attach_recording":
        await asAgentError(() =>
          attachRecordingCore(mctx, actor, {
            recordingId: a.recordingId,
            ...(a.meetingId ? { meetingId: a.meetingId } : {}),
            ...(a.notASalesCall ? { notASalesCall: true } : {}),
          }, provenance),
        );
        return { recording: a.notASalesCall ? "ignored" : "matched" };
    }
  },
};

const actionArg = v.union(
  v.object({ kind: v.literal("retry_delivery"), deliveryId: v.id("webhookDeliveries"), generation: v.number() }),
  v.object({
    kind: v.literal("retry_projection"),
    projection: v.union(v.literal("meeting"), v.literal("opportunity")),
    id: v.string(),
    generation: v.number(),
  }),
  v.object({
    kind: v.literal("link_fathom_recorder"),
    memberId: v.id("fathomOrgMembers"),
    userId: v.optional(v.id("users")),
    ignored: v.optional(v.boolean()),
  }),
  v.object({
    kind: v.literal("attach_recording"),
    recordingId: v.id("callRecordings"),
    meetingId: v.optional(v.id("meetings")),
    notASalesCall: v.optional(v.boolean()),
  }),
);

export const repairArgs = { caller: mcpCallerValidator, action: actionArg };

export const prepareRepair = internalMutation({
  args: repairArgs,
  returns: v.any(),
  handler: async (ctx, { caller, action }) => {
    const me = await requireMcpAdmin(ctx, caller, { family: "repairs", permission: "settings:manage" });
    const actor = actorOf(me);
    const args: RepairArgs = { action };
    const go = (summary: string, target: { kind: string; id: string; label: string }, preview: Record<string, unknown>) =>
      prepareSingle(ctx, actor, repairCommitter, args, { action: action.kind, target, summary, preview });

    switch (action.kind) {
      case "retry_delivery": {
        const row = await loadInTenant(ctx, me, "webhookDeliveries", action.deliveryId, "that booking delivery");
        if (row.generation !== action.generation)
          throw rejectRequest("repair.stale", "That delivery changed since you looked. Read it again with magnus_health.");
        const when = formatLocal(row.occurredAt, me.timeZone);
        return await go(
          `Retry the ${row.eventType} delivery from ${when}`,
          { kind: "delivery", id: row._id, label: `${row.eventType} · ${when}` },
          { delivery: { event: row.eventType, when, status: row.status }, effect: "Magnus processes the booking again. The outcome shows in magnus_health.", openInMagnus: appLink("/workspace/operations/booking-health") },
        );
      }
      case "retry_projection": {
        const table = action.projection === "meeting" ? "meetingProjections" : "opportunityProjectionJobs";
        const id = ctx.db.normalizeId(table, action.id);
        const row = id ? ((await ctx.db.get(table, id as never)) as { tenantId: Id<"tenants">; status: string; generation: number } | null) : null;
        if (!row || row.tenantId !== me.tenantId) throw rejectRequest("mcp.not_found", "Magnus can't find that projection.");
        if (row.generation !== action.generation || row.status !== "failed")
          throw rejectRequest("repair.stale", "That rebuild changed since you looked, or hasn't failed. Read it again with magnus_health.");
        return await go(
          `Rebuild the failed ${action.projection} projection`,
          { kind: "projection", id: action.id, label: `${action.projection} projection` },
          { projection: { kind: action.projection, status: row.status }, effect: "Magnus rebuilds the report rows for this record.", openInMagnus: appLink("/workspace/operations/work-status") },
        );
      }
      case "link_fathom_recorder": {
        const m = await loadInTenant(ctx, me, "fathomOrgMembers", action.memberId, "that Fathom recorder");
        if (Boolean(action.userId) === Boolean(action.ignored))
          throw rejectRequest("fathom.invalid_link", "Choose a teammate or ignore this recorder.");
        const user = action.userId ? await loadInTenant(ctx, me, "users", action.userId, "that teammate") : null;
        const recorder = { text: m.name ?? "Unnamed recorder", by: "integration" as const };
        return await go(
          action.ignored ? `Ignore Fathom recorder ${recorder.text}` : `Link Fathom recorder ${recorder.text} to ${user?.fullName ?? user?.email}`,
          { kind: "fathom_member", id: m._id, label: recorder.text },
          {
            recorder,
            ...(user ? { teammate: user.fullName ?? user.email } : { result: "Ignored. Their recordings stop matching." }),
            openInMagnus: appLink("/workspace/settings/fathom"),
          },
        );
      }
      case "attach_recording": {
        const r = await loadInTenant(ctx, me, "callRecordings", action.recordingId, "that recording");
        if (Boolean(action.meetingId) === Boolean(action.notASalesCall))
          throw rejectRequest("fathom.invalid_assignment", "Choose a meeting or Not a sales call.");
        const title = { text: r.title, by: "integration" as const };
        const recorded = formatLocal(r.recordingStartAt, me.timeZone);
        let meetingLabel: string | null = null;
        if (action.meetingId) {
          const meeting = await loadInTenant(ctx, me, "meetings", action.meetingId, "that meeting");
          meetingLabel = `${meeting.leadName ?? "this person"} · ${formatLocal(meeting.scheduledAt, me.timeZone)}`;
        }
        return await go(
          meetingLabel ? `Attach the ${recorded} recording to ${meetingLabel}` : `Mark the ${recorded} recording as not a sales call`,
          { kind: "recording", id: r._id, label: `${title.text} · ${recorded}` },
          {
            recording: { title, recorded },
            ...(meetingLabel ? { meeting: { text: meetingLabel, by: "person" } } : { result: "Not a sales call" }),
            openInMagnus: appLink("/workspace/recordings"),
          },
        );
      }
    }
  },
});
