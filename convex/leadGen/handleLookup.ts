import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { followMergeChain } from "../leads/identityResolution";
import { LIFECYCLE_STAGE_LABELS, type Disposition, type LifecycleStage } from "../leads/lifecycle";
import { normalizeLeadGenProspectInput } from "./normalization";

/**
 * What Magnus knows about a handle, read without saving anything
 * (docs/plans/lead-gen-assistant.md §2, row 2). A capture answers the same
 * question, but only by recording the capture and counting a dupe. The check
 * tool and the capture preview both read this, so a preview shows what the
 * check showed.
 *
 * It follows the capture's own steps: the prospect by dedupe key first, and
 * otherwise the person who holds the Instagram handle. A handle two people
 * hold, or one that points at a broken record, is a conflict, as it is for a
 * capture (`findOrCreateCapturePerson`).
 */
export type HandleVerdict =
  | "new"
  | "known"
  | "captured_before"
  | "not_a_fit"
  | "do_not_contact"
  | "conflict";

export type HandleLookup =
  | { input: string; valid: false; reason: string }
  | {
      input: string;
      valid: true;
      handle: string;
      dedupeKey: string;
      verdict: HandleVerdict;
      prospect: Doc<"leadGenProspects"> | null;
      lead: Doc<"leads"> | null;
    };

// findLeadByIdentifier reads 17 and blocks past 16; the same bound here.
const IDENTIFIER_READ_LIMIT = 17;

async function handleHolders(
  ctx: QueryCtx | MutationCtx,
  tenantId: Id<"tenants">,
  handle: string,
): Promise<{ lead: Doc<"leads"> | null; conflict: boolean }> {
  const identifiers = await ctx.db
    .query("leadIdentifiers")
    .withIndex("by_tenantId_and_type_and_value", (q) =>
      q.eq("tenantId", tenantId).eq("type", "instagram").eq("value", handle),
    )
    .take(IDENTIFIER_READ_LIMIT);
  if (identifiers.length >= IDENTIFIER_READ_LIMIT) return { lead: null, conflict: true };
  const people = new Map<Id<"leads">, Doc<"leads">>();
  for (const identifier of identifiers) {
    const lead = await ctx.db.get("leads", identifier.leadId);
    if (!lead || lead.tenantId !== tenantId) return { lead: null, conflict: true };
    const resolved = await followMergeChain(ctx, lead);
    if (!resolved) return { lead: null, conflict: true };
    people.set(resolved._id, resolved);
  }
  if (people.size > 1) return { lead: null, conflict: true };
  return { lead: people.values().next().value ?? null, conflict: false };
}

function verdictFor(lead: Doc<"leads">, capturedBefore: boolean): HandleVerdict {
  if (lead.disposition === "do_not_contact") return "do_not_contact";
  if (lead.disposition === "not_a_fit") return "not_a_fit";
  return capturedBefore ? "captured_before" : "known";
}

export async function lookupHandle(
  ctx: QueryCtx | MutationCtx,
  tenantId: Id<"tenants">,
  input: string,
): Promise<HandleLookup> {
  let normalized: ReturnType<typeof normalizeLeadGenProspectInput>;
  try {
    // Both sources share one handle space (`instagram:<handle>`).
    normalized = normalizeLeadGenProspectInput({ source: "instagram", rawHandleOrProfileUrl: input });
  } catch {
    return { input, valid: false, reason: "Not an Instagram handle or profile URL" };
  }
  const base = { input, valid: true as const, handle: normalized.normalizedHandle, dedupeKey: normalized.dedupeKey };

  const prospect = await ctx.db
    .query("leadGenProspects")
    .withIndex("by_tenantId_and_dedupeKey", (q) => q.eq("tenantId", tenantId).eq("dedupeKey", normalized.dedupeKey))
    .unique();
  if (prospect) {
    const lead = await ctx.db.get("leads", prospect.leadId);
    if (!lead) return { ...base, verdict: "conflict", prospect, lead: null };
    return { ...base, verdict: verdictFor(lead, prospect.contactAttemptCount > 0), prospect, lead };
  }

  const holder = await handleHolders(ctx, tenantId, normalized.normalizedHandle);
  if (holder.conflict) return { ...base, verdict: "conflict", prospect: null, lead: null };
  if (!holder.lead) return { ...base, verdict: "new", prospect: null, lead: null };
  return { ...base, verdict: verdictFor(holder.lead, false), prospect: null, lead: holder.lead };
}

/** Lines that normalize to one handle are one line; the first spelling wins. */
export function mergeLookups(lookups: HandleLookup[]): HandleLookup[] {
  const seen = new Set<string>();
  return lookups.filter((lookup) => {
    if (!lookup.valid) return true;
    if (seen.has(lookup.dedupeKey)) return false;
    seen.add(lookup.dedupeKey);
    return true;
  });
}

const VERDICT_WORDS: Record<HandleVerdict, string> = {
  new: "New to Magnus",
  known: "Already in the CRM",
  captured_before: "Captured before",
  not_a_fit: "Already in the CRM, not a fit",
  do_not_contact: "Do not contact. Don't message them",
  conflict: "This handle matches more than one person. Ask an admin to merge them",
};

export function stageLabel(stage: LifecycleStage): string {
  return LIFECYCLE_STAGE_LABELS[stage].toLowerCase();
}

/** One plain line for a handle, with no dates, so a preview reads the same until something changes. */
export function verdictLine(lookup: Extract<HandleLookup, { valid: true }>): string {
  const words = VERDICT_WORDS[lookup.verdict];
  const showStage = lookup.lead && (lookup.verdict === "known" || lookup.verdict === "captured_before");
  return showStage ? `${words}, ${stageLabel(lookup.lead!.lifecycleStage)}` : words;
}

export type HandleStanding = { stage: LifecycleStage; disposition: Disposition } | null;

export function standingOf(lookup: Extract<HandleLookup, { valid: true }>): HandleStanding {
  return lookup.lead ? { stage: lookup.lead.lifecycleStage, disposition: lookup.lead.disposition } : null;
}
