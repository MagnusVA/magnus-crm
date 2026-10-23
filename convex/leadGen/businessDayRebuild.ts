import { v, type Infer } from "convex/values";
import { internalMutation } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { rebuildStageValue } from "../businessDaySchema";
import { businessDateForInstant } from "../../lib/businessDay";
import { getTenantBusinessDay } from "../lib/tenantBusinessDay";
import { normalizeLeadGenOrigin } from "./normalization";
import { snapshotLeadGenScheduledHours, teamOriginStatKey } from "./aggregates";

type Rebuild = Doc<"businessDayRebuilds">;
type Value = Infer<typeof rebuildStageValue>;
export const LEAD_GEN_DAY_TABLES = { daily: "leadGenDailyStats", origin: "leadGenOriginStats", team_origin: "leadGenTeamOriginStats" } as const;
function keyFor(value: Value) {
  return `${value.kind}:${value.kind === "origin" ? `${value.originKey}:${value.dayKey}` : value.statKey}`;
}
async function stage(ctx: MutationCtx, job: Rebuild, value: Value) {
  const key = keyFor(value);
  return await ctx.db.query("businessDayRebuildRows").withIndex("by_rebuildId_and_pass_and_key", q => q.eq("rebuildId", job._id).eq("pass", job.pass).eq("key", key)).unique();
}
async function put(ctx: MutationCtx, job: Rebuild, value: Value, accumulate: boolean) {
  const old = await stage(ctx, job, value);
  if (old && !accumulate) return;
  if (old) {
    value = { ...value, submissions: old.value.submissions + value.submissions, uniqueProspectsSubmitted: old.value.uniqueProspectsSubmitted + value.uniqueProspectsSubmitted };
    if (value.kind === "daily" && old.value.kind === "daily") value.duplicateProspectSubmissions += old.value.duplicateProspectSubmissions;
    await ctx.db.patch("businessDayRebuildRows", old._id, { value, round: job.catchUpPasses ?? 0 });
  } else await ctx.db.insert("businessDayRebuildRows", { tenantId: job.tenantId, rebuildId: job._id, pass: job.pass, key: keyFor(value), round: job.catchUpPasses ?? 0, value });
}
async function first(ctx: MutationCtx, job: Rebuild, key: string) {
  const seen = await ctx.db.query("businessDayRebuildSeen").withIndex("by_rebuildId_and_pass_and_key", q => q.eq("rebuildId", job._id).eq("pass", job.pass).eq("key", key)).unique();
  if (seen) return false;
  await ctx.db.insert("businessDayRebuildSeen", { tenantId: job.tenantId, rebuildId: job._id, pass: job.pass, key });
  return true;
}

/** First retain every old key with zero counters; no live row is cleared here. */
export async function seedLeadGenDayPage(ctx: MutationCtx, job: Rebuild, kind: keyof typeof LEAD_GEN_DAY_TABLES) {
  const page = await ctx.db.query(LEAD_GEN_DAY_TABLES[kind]).withIndex("by_tenantId_and_dayKey", q => q.eq("tenantId", job.tenantId)).paginate({ cursor: job.cursor, numItems: 200 });
  for (const row of page.page) {
    const { _id, _creationTime, ...fields } = row;
    void _id; void _creationTime;
    // The table discriminant determines fields; the union query cannot retain it.
    const value = { ...fields, kind, submissions: 0, uniqueProspectsSubmitted: 0, ...("duplicateProspectSubmissions" in fields ? { duplicateProspectSubmissions: 0 } : {}) } as Value;
    await put(ctx, job, value, false);
  }
  return page;
}

/** Source order assigns prospect/day uniqueness to its first active submission. */
export async function computeLeadGenDayPage(ctx: MutationCtx, job: Rebuild) {
  const setting = await getTenantBusinessDay(ctx, job.tenantId);
  if (job.watermark === undefined) throw new Error("Missing lead gen watermark; retry the rebuild.");
  const page = await ctx.db.query("leadGenSubmissions").withIndex("by_tenantId_and_submittedAt", q => {
    const tenant = q.eq("tenantId", job.tenantId);
    return job.lowerWatermark === undefined
      ? tenant.lt("submittedAt", job.watermark!)
      : tenant.gte("submittedAt", job.lowerWatermark).lt("submittedAt", job.watermark!);
  }).paginate({ cursor: job.cursor, numItems: 200 });
  for (const row of page.page) {
    // Lifetime duplicates include voided prior attempts, matching capture and void hooks.
    const firstAttempt = await first(ctx, job, `attempt:${row.prospectId}`);
    if (row.voidedAt !== undefined) continue;
    const dayKey = businessDateForInstant(row.submittedAt, setting);
    const worker = await ctx.db.get("leadGenWorkers", row.workerId);
    if (!worker || worker.tenantId !== job.tenantId) throw new Error(`${row._id}`);
    const unique = await first(ctx, job, `day:${dayKey}:${row.prospectId}`);
    await put(ctx, job, {
      kind: "daily", tenantId: job.tenantId, dayKey, statKey: [dayKey, row.workerId, row.teamId ?? "none", row.source].join(":"),
      workerId: row.workerId, userId: row.userId, teamId: row.teamId, source: row.source,
      submissions: 1, uniqueProspectsSubmitted: Number(unique), duplicateProspectSubmissions: Number(!firstAttempt),
      scheduledHours: await snapshotLeadGenScheduledHours(ctx, { worker, dayKey }), updatedAt: job.requestedAt,
    }, true);
    if (!row.originRankable || !row.originValue) continue;
    const origin = normalizeLeadGenOrigin({ originKind: row.originKind, originUrlOrLabel: row.originValue });
    if (!origin.originKey || !origin.originValue) continue;
    const common = { tenantId: job.tenantId, dayKey, source: row.source, originKind: row.originKind, originKey: origin.originKey, originValue: origin.originValue, submissions: 1, updatedAt: job.requestedAt };
    await put(ctx, job, { ...common, kind: "origin", uniqueProspectsSubmitted: Number(await first(ctx, job, `origin:${dayKey}:${origin.originKey}:${row.prospectId}`)) }, true);
    await put(ctx, job, { ...common, kind: "team_origin", teamId: row.teamId, statKey: teamOriginStatKey({ ...common, teamId: row.teamId }), uniqueProspectsSubmitted: Number(await first(ctx, job, `team_origin:${dayKey}:${row.teamId ?? "none"}:${row.source}:${origin.originKey}:${row.prospectId}`)) }, true);
  }
  return page;
}

async function liveRow(ctx: MutationCtx, value: Value) {
  if (value.kind === "origin") return ctx.db.query("leadGenOriginStats").withIndex("by_tenantId_and_originKey_and_dayKey", q => q.eq("tenantId", value.tenantId).eq("originKey", value.originKey).eq("dayKey", value.dayKey)).unique();
  return ctx.db.query(LEAD_GEN_DAY_TABLES[value.kind]).withIndex("by_tenantId_and_statKey", q => q.eq("tenantId", value.tenantId).eq("statKey", value.statKey)).unique();
}
export async function swapLeadGenDayPage(ctx: MutationCtx, job: Rebuild, audit: boolean) {
  const page = await ctx.db.query("businessDayRebuildRows").withIndex("by_rebuildId_and_pass_and_round_and_key", q => q.eq("rebuildId", job._id).eq("pass", job.pass).eq("round", job.catchUpPasses ?? 0)).paginate({ cursor: job.cursor, numItems: 200 });
  for (const row of page.page) {
    const old = await liveRow(ctx, row.value);
    const { kind, ...value } = row.value;
    if (audit) {
      // Source-derived counters cover daily, origin and team-origin audits, including old keys now zero.
      if ((old?.submissions ?? 0) !== value.submissions || (old?.uniqueProspectsSubmitted ?? 0) !== value.uniqueProspectsSubmitted || ("duplicateProspectSubmissions" in value && ((old && "duplicateProspectSubmissions" in old ? old.duplicateProspectSubmissions : 0) !== value.duplicateProspectSubmissions))) throw new Error(`${row._id}`);
    } else if (value.submissions === 0) {
      if (old) await ctx.db.delete(LEAD_GEN_DAY_TABLES[kind], old._id);
    } else if (old) {
      if (row.value.kind === "daily") { const { kind: _, ...data } = row.value; void _; await ctx.db.replace("leadGenDailyStats", old._id as Doc<"leadGenDailyStats">["_id"], data); }
      else if (row.value.kind === "origin") { const { kind: _, ...data } = row.value; void _; await ctx.db.replace("leadGenOriginStats", old._id as Doc<"leadGenOriginStats">["_id"], data); }
      else { const { kind: _, ...data } = row.value; void _; await ctx.db.replace("leadGenTeamOriginStats", old._id as Doc<"leadGenTeamOriginStats">["_id"], data); }
    } else {
      if (row.value.kind === "daily") { const { kind: _, ...data } = row.value; void _; await ctx.db.insert("leadGenDailyStats", data); }
      else if (row.value.kind === "origin") { const { kind: _, ...data } = row.value; void _; await ctx.db.insert("leadGenOriginStats", data); }
      else { const { kind: _, ...data } = row.value; void _; await ctx.db.insert("leadGenTeamOriginStats", data); }
    }
  }
  return page;
}

async function moveLeadGen(ctx: MutationCtx, job: Rebuild, phase: Rebuild["phase"], cursor: string | null = null) {
  await ctx.db.patch("businessDayRebuilds", job._id, { phase, cursor });
}
export const rebuildLeadGenDayStats = internalMutation({
  args: { tenantId: v.id("tenants"), rebuildId: v.id("businessDayRebuilds") }, returns: v.null(),
  handler: async (ctx, { tenantId, rebuildId }): Promise<null> => {
    const job = await ctx.db.get("businessDayRebuilds", rebuildId);
    if (!job || job.tenantId !== tenantId || job.state !== "running") throw new Error(`${rebuildId}`);
    if (job.phase.startsWith("seed_")) {
      const kind = job.phase === "seed_daily" ? "daily" : job.phase === "seed_origin" ? "origin" : "team_origin";
      const page = await seedLeadGenDayPage(ctx, job, kind);
      const next = kind === "daily" ? "seed_origin" : kind === "origin" ? "seed_team_origin" : "compute";
      await moveLeadGen(ctx, job, page.isDone ? next : job.phase, page.isDone ? null : page.continueCursor);
      if (page.isDone && next === "compute") await ctx.db.patch("businessDayRebuilds", rebuildId, { computedRevision: job.sourceRevision, computedCorrectionRevision: job.correctionRevision ?? 0, watermark: Date.now(), catchUpPasses: 0 });
    } else if (["compute", "swap", "audit_lead_gen"].includes(job.phase)) {
      if ((job.correctionRevision ?? 0) !== (job.computedCorrectionRevision ?? 0)) {
        throw new Error("A lead gen submission was corrected during the rebuild. Retry to take a new snapshot.");
      }
      const page = job.phase === "compute" ? await computeLeadGenDayPage(ctx, job) : await swapLeadGenDayPage(ctx, job, job.phase === "audit_lead_gen");
      const counter = job.phase === "compute" ? "leadGenRowsComputed" : job.phase === "swap" ? "leadGenRowsSwapped" : "leadGenAudited";
      await ctx.db.patch("businessDayRebuilds", rebuildId, { [counter]: job[counter] + page.page.length });
      const next = job.phase === "compute" ? "swap" : job.phase === "swap" ? "audit_lead_gen" : "drain";
      await moveLeadGen(ctx, job, page.isDone ? next : job.phase, page.isDone ? null : page.continueCursor);
      if (page.isDone && next === "drain") {
        // This read and the leadGenDone write form the final OCC fence. Captures
        // after it resume normal live counters; earlier captures must be included.
        const tail = await ctx.db.query("leadGenSubmissions").withIndex("by_tenantId_and_submittedAt", q => q.eq("tenantId", tenantId).gte("submittedAt", job.watermark!)).first();
        if (tail || job.sourceRevision !== job.computedRevision) {
          const catchUpPasses = job.catchUpPasses ?? 0;
          if (catchUpPasses >= 5) throw new Error("Lead gen rebuild did not converge after 5 catch-up passes. Retry when capture traffic is lower.");
          await ctx.db.patch("businessDayRebuilds", rebuildId, {
            lowerWatermark: job.watermark, watermark: Date.now(), catchUpPasses: catchUpPasses + 1,
            computedRevision: job.sourceRevision, phase: "compute", cursor: null,
          });
        } else {
          await ctx.db.patch("businessDayRebuilds", rebuildId, { leadGenDone: true });
        }
      }
    }
    return null;
  },
});
