import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { LIFECYCLE_STAGES, type LifecycleStage } from "../leads/lifecycle";
import { prospectConversions } from "../reporting/aggregates";

// Keeps `prospectConversions` in step with each linked prospect and its
// person (docs/plans/phase-2-person-first.md §7). A prospect counts at
// Prospect, and at each later stage its person reached at or after the
// prospect's first capture (D6), so a worker who captures someone already
// qualified gets the prospect and not the qualification.

// Far above the prospects one person has (one per handle). A person past it
// throws rather than count from partial data, as lifecycle derivation does.
export const PERSON_PROSPECT_LIMIT = 200;

function entryId(prospectId: Id<"leadGenProspects">, stage: LifecycleStage): string {
  return `${prospectId}:${stage}`;
}

function entryKey(
  prospect: Doc<"leadGenProspects">,
  stage: LifecycleStage,
): [Id<"leadGenWorkers">, LifecycleStage, number] {
  return [prospect.firstCapturedByWorkerId, stage, prospect.firstCapturedAt];
}

/** The stages a prospect counts at, given its person. */
export function prospectConversionStages(
  prospect: Doc<"leadGenProspects">,
  lead: Doc<"leads"> | null,
): LifecycleStage[] {
  if (!lead || lead.status === "merged" || prospect.leadId !== lead._id) {
    return [];
  }
  return LIFECYCLE_STAGES.filter((stage) => {
    if (stage === "prospect") {
      return true;
    }
    const at = lead.lifecycleStageEnteredAt[stage];
    return at !== undefined && at >= prospect.firstCapturedAt;
  });
}

/** Brings one prospect's entries in line with its person. Idempotent. */
export async function syncProspectConversions(
  ctx: MutationCtx,
  prospect: Doc<"leadGenProspects">,
  lead: Doc<"leads"> | null,
): Promise<void> {
  const stages = new Set(prospectConversionStages(prospect, lead));
  for (const stage of LIFECYCLE_STAGES) {
    const entry = {
      namespace: prospect.tenantId,
      key: entryKey(prospect, stage),
      id: entryId(prospect._id, stage),
    };
    if (stages.has(stage)) {
      await prospectConversions.insertIfDoesNotExist(ctx, entry);
    } else {
      await prospectConversions.deleteIfExists(ctx, entry);
    }
  }
}

/** The person's prospects, bounded. */
export async function personProspects(
  ctx: QueryCtx | MutationCtx,
  tenantId: Id<"tenants">,
  leadId: Id<"leads">,
): Promise<Doc<"leadGenProspects">[]> {
  const prospects = await ctx.db
    .query("leadGenProspects")
    .withIndex("by_tenantId_and_leadId", (q) => q.eq("tenantId", tenantId).eq("leadId", leadId))
    .take(PERSON_PROSPECT_LIMIT + 1);
  if (prospects.length > PERSON_PROSPECT_LIMIT) {
    throw new Error(`Lead ${leadId} has more than ${PERSON_PROSPECT_LIMIT} lead gen prospects`);
  }
  return prospects;
}

/** Re-syncs every prospect of a person whose stage times changed. */
export async function syncPersonProspectConversions(
  ctx: MutationCtx,
  lead: Doc<"leads">,
): Promise<void> {
  for (const prospect of await personProspects(ctx, lead.tenantId, lead._id)) {
    await syncProspectConversions(ctx, prospect, lead);
  }
}

async function hasEntry(
  ctx: QueryCtx | MutationCtx,
  prospect: Doc<"leadGenProspects">,
  stage: LifecycleStage,
): Promise<boolean> {
  const bound = { key: entryKey(prospect, stage), id: entryId(prospect._id, stage), inclusive: true };
  return (
    (await prospectConversions.count(ctx, {
      namespace: prospect.tenantId,
      bounds: { lower: bound, upper: bound },
    })) === 1
  );
}

/** What is wrong with a prospect's entries, compared with its person. */
export async function prospectConversionProblems(
  ctx: QueryCtx | MutationCtx,
  prospect: Doc<"leadGenProspects">,
  lead: Doc<"leads"> | null,
): Promise<string[]> {
  const expected = new Set(prospectConversionStages(prospect, lead));
  const problems: string[] = [];
  for (const stage of LIFECYCLE_STAGES) {
    const has = await hasEntry(ctx, prospect, stage);
    if (has && !expected.has(stage)) {
      problems.push(`extra ${stage} conversion entry`);
    } else if (!has && expected.has(stage)) {
      problems.push(`missing ${stage} conversion entry`);
    }
  }
  return problems;
}

/** Prospects a worker first captured in `[startAt, endAt)` that reached `stage`. */
export async function countProspectConversions(
  ctx: QueryCtx | MutationCtx,
  tenantId: Id<"tenants">,
  workerId: Id<"leadGenWorkers">,
  stage: LifecycleStage,
  startAt: number,
  endAt: number,
): Promise<number> {
  return await prospectConversions.count(ctx, {
    namespace: tenantId,
    bounds: {
      lower: { key: [workerId, stage, startAt], inclusive: true },
      upper: { key: [workerId, stage, endAt], inclusive: false },
    },
  });
}
