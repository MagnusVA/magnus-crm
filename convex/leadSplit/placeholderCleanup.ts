import { v, type Infer } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { rebuildLeadCustomerSearchRow } from "../leadCustomers/projection";
import { buildLeadSearchText } from "../leads/searchTextBuilder";
import { emitDomainEvent } from "../lib/domainEvents";
import { leadDisplayString } from "../lib/leadDisplay";
import {
  isPlaceholderEmail,
  isPlaceholderHandle,
  isPlaceholderPhone,
  normalizeEmail,
} from "../lib/normalization";
import { log } from "../lib/observability/log";
import { refreshOpportunitySearchForLead } from "../lib/opportunitySearch";
import { syncCustomerSnapshot } from "../lib/syncCustomerSnapshot";
import { syncLeadMeetingNames } from "../lib/syncLeadMeetingNames";
import {
  rebuildQualificationRow,
  rebuildQualificationRowsForOpportunity,
} from "../operations/projections";
import { storedPatch, withoutSystemFields } from "./audit";

/*
 * The Tier D cleanup of docs/plans/polluted-lead-split.md §3.5: single-person
 * leads that still hold a placeholder value (`email@yahoo.com`, a fake phone,
 * a handle like `na`). The guards keep these values out of identity matching,
 * but each one stays on the lead as an identifier and in its contact fields.
 *
 * `preview` lists every such lead, read-only. `cleanLead` removes exactly what
 * a reviewed preview listed for one lead, and refuses if that has changed.
 * Each write records an undo row; `undoLead` puts the lead back.
 */

const PAGE_SIZE = 200;
/** A lead with more identifiers than this is left for review. */
const IDENTIFIER_LIMIT = 50;
const ROW_LIMIT = 200;
const leadFieldValidator = v.union(
  v.literal("email"),
  v.literal("phone"),
  v.literal("socialHandles"),
);
type LeadField = Infer<typeof leadFieldValidator>;

const candidateValidator = v.object({
  leadId: v.id("leads"),
  identifierIds: v.array(v.id("leadIdentifiers")),
  identifierTypes: v.array(v.string()),
  fields: v.array(leadFieldValidator),
  /** Why the lead is listed but won't be cleaned. */
  skipped: v.optional(v.string()),
});
type Candidate = Infer<typeof candidateValidator>;

/** Whether an identifier's value is one the rules reject as a placeholder. */
function isPlaceholderIdentifier(identifier: Doc<"leadIdentifiers">): boolean {
  if (identifier.type === "email") return isPlaceholderEmail(identifier.value);
  if (identifier.type === "phone") return isPlaceholderPhone(identifier.value);
  return isPlaceholderHandle(identifier.value);
}

function isPlaceholderLeadEmail(email: string | undefined): boolean {
  const normalized = email === undefined ? undefined : normalizeEmail(email);
  return normalized !== undefined && isPlaceholderEmail(normalized);
}

/** What the cleanup would change on a lead, in a stable order. */
function placeholdersOf(lead: Doc<"leads">, identifiers: Doc<"leadIdentifiers">[]) {
  const placeholderIdentifiers = identifiers
    .filter(isPlaceholderIdentifier)
    .sort((a, b) => a._id.localeCompare(b._id));
  const fields: LeadField[] = [];
  if (isPlaceholderLeadEmail(lead.email)) fields.push("email");
  if (lead.phone !== undefined && isPlaceholderPhone(lead.phone)) fields.push("phone");
  if (lead.socialHandles?.some((social) => isPlaceholderHandle(social.handle))) {
    fields.push("socialHandles");
  }
  return { placeholderIdentifiers, fields };
}

async function readIdentifiers(ctx: QueryCtx, leadId: Id<"leads">) {
  return await ctx.db
    .query("leadIdentifiers")
    .withIndex("by_leadId", (q) => q.eq("leadId", leadId))
    .take(IDENTIFIER_LIMIT + 1);
}

/** Split plans that may still change the lead. */
const OPEN_PLAN_STATUSES = new Set(["draft", "needs_review", "approved", "applying", "failed"]);

/**
 * Why a lead with placeholders is left alone: a merged lead holds nothing, a
 * lead a split still covers is the split's to fix (Tier A and B), and one with
 * more identifiers than the cleanup reads needs a person to look.
 */
async function skipReason(
  ctx: QueryCtx,
  lead: Doc<"leads">,
  identifierCount: number,
): Promise<string | undefined> {
  if (lead.status === "merged") return "merged";
  if (lead.splitLockedAt !== undefined) return "split_locked";
  if (identifierCount > IDENTIFIER_LIMIT) return "too_many_identifiers";
  const plans = await ctx.db
    .query("leadSplitPlans")
    .withIndex("by_tenantId_and_sourceLeadId", (q) =>
      q.eq("tenantId", lead.tenantId).eq("sourceLeadId", lead._id),
    )
    .take(8);
  if (plans.some((plan) => OPEN_PLAN_STATUSES.has(plan.status))) return "open_split_plan";
  return undefined;
}

async function candidateFor(ctx: QueryCtx, lead: Doc<"leads">): Promise<Candidate | undefined> {
  const identifiers = await readIdentifiers(ctx, lead._id);
  const { placeholderIdentifiers, fields } = placeholdersOf(lead, identifiers);
  if (placeholderIdentifiers.length === 0 && fields.length === 0) return undefined;
  return {
    leadId: lead._id,
    identifierIds: placeholderIdentifiers.map((identifier) => identifier._id),
    identifierTypes: placeholderIdentifiers.map((identifier) => identifier.type),
    fields,
    skipped: await skipReason(ctx, lead, identifiers.length),
  };
}

export const previewPage = internalQuery({
  args: { tenantId: v.id("tenants"), cursor: v.union(v.string(), v.null()) },
  returns: v.object({
    candidates: v.array(candidateValidator),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, { tenantId, cursor }) => {
    const page = await ctx.db
      .query("leads")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .paginate({ cursor, numItems: PAGE_SIZE });
    const candidates: Candidate[] = [];
    for (const lead of page.page) {
      const candidate = await candidateFor(ctx, lead);
      if (candidate) candidates.push(candidate);
    }
    return { candidates, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

/**
 * Every lead of the tenant holding a placeholder identifier or contact field,
 * read-only. Its output, minus skipped leads, is what `cleanLead` takes.
 */
export const preview = internalAction({
  args: { tenantId: v.id("tenants") },
  returns: v.array(candidateValidator),
  handler: async (ctx, { tenantId }) => {
    const candidates: Candidate[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page: {
        candidates: Candidate[];
        isDone: boolean;
        continueCursor: string;
      } = await ctx.runQuery(internal.leadSplit.placeholderCleanup.previewPage, {
        tenantId,
        cursor,
      });
      candidates.push(...page.candidates);
      if (page.isDone) return candidates;
      cursor = page.continueCursor;
    }
  },
});

/**
 * Rebuilds everything that copies the lead's contact fields. The lead's own
 * `searchText` is part of the audited patch, so undo restores it exactly.
 */
async function refreshLeadCopies(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  leadId: Id<"leads">,
) {
  const lead = await ctx.db.get("leads", leadId);
  if (!lead) throw new Error(`Lead ${leadId} not found`);
  const identifiers = await readIdentifiers(ctx, leadId);
  await refreshOpportunitySearchForLead(ctx, tenantId, leadId);
  await syncCustomerSnapshot(ctx, tenantId, leadId);
  await syncLeadMeetingNames(ctx, tenantId, leadId, leadDisplayString(lead, identifiers));
  await rebuildLeadCustomerSearchRow(ctx, tenantId, leadId);
  // Qualification rows copy the lead's contact fields.
  const opportunities = await ctx.db
    .query("opportunities")
    .withIndex("by_tenantId_and_leadId", (q) => q.eq("tenantId", tenantId).eq("leadId", leadId))
    .take(ROW_LIMIT);
  for (const opportunity of opportunities) {
    await rebuildQualificationRowsForOpportunity(ctx, opportunity._id);
  }
  const events = await ctx.db
    .query("slackQualificationEvents")
    .withIndex("by_tenantId_and_leadId_and_submittedAt", (q) =>
      q.eq("tenantId", tenantId).eq("leadId", leadId),
    )
    .take(ROW_LIMIT);
  for (const event of events) await rebuildQualificationRow(ctx, event._id);
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((value, i) => value === [...b].sort()[i]);

/**
 * Removes one lead's placeholders: deletes the placeholder identifiers and
 * clears the placeholder contact fields. `identifierIds` and `fields` come
 * from a reviewed `preview`; the cleanup refuses if the lead's placeholders
 * no longer match them, so it changes only what was approved.
 */
export const cleanLead = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    leadId: v.id("leads"),
    identifierIds: v.array(v.id("leadIdentifiers")),
    fields: v.array(leadFieldValidator),
    approvedBy: v.string(),
  },
  returns: v.object({ identifiersDeleted: v.number(), fieldsCleared: v.array(leadFieldValidator) }),
  handler: async (ctx, { tenantId, leadId, identifierIds, fields, approvedBy }) => {
    if (!approvedBy.trim()) throw new Error("Name who approved the cleanup");
    const lead = await ctx.db.get("leads", leadId);
    if (!lead || lead.tenantId !== tenantId) throw new Error(`Lead ${leadId} not found`);
    const identifiers = await readIdentifiers(ctx, leadId);
    const skipped = await skipReason(ctx, lead, identifiers.length);
    if (skipped) throw new Error(`Lead ${leadId} can't be cleaned: ${skipped}`);
    const current = placeholdersOf(lead, identifiers);
    if (
      !sameList(current.placeholderIdentifiers.map((identifier) => identifier._id), identifierIds) ||
      !sameList(current.fields, fields)
    )
      throw new Error(`Lead ${leadId}'s placeholders changed since the preview`);

    // One cleanup at a time per lead, so an undo restores all of it.
    const pending = await ctx.db
      .query("leadPlaceholderCleanups")
      .withIndex("by_leadId_and_revertedAt", (q) => q.eq("leadId", leadId).eq("revertedAt", undefined))
      .first();
    if (pending) throw new Error(`Lead ${leadId} has a cleanup that hasn't been undone`);

    const now = Date.now();
    const audit = { tenantId, leadId, approvedBy, createdAt: now };
    for (const identifier of current.placeholderIdentifiers) {
      await ctx.db.insert("leadPlaceholderCleanups", {
        ...audit,
        table: "leadIdentifiers",
        docId: identifier._id,
        op: "delete",
        before: withoutSystemFields(identifier),
      });
      await ctx.db.delete("leadIdentifiers", identifier._id);
    }
    const patch: Partial<Doc<"leads">> = {};
    if (current.fields.includes("email")) patch.email = undefined;
    if (current.fields.includes("phone")) patch.phone = undefined;
    if (current.fields.includes("socialHandles")) {
      const kept = lead.socialHandles?.filter((social) => !isPlaceholderHandle(social.handle));
      patch.socialHandles = kept?.length ? kept : undefined;
    }
    const deleted = new Set<string>(current.placeholderIdentifiers.map((identifier) => identifier._id));
    const searchText = buildLeadSearchText(
      { ...lead, ...patch },
      identifiers.filter((identifier) => !deleted.has(identifier._id)).map((identifier) => identifier.value),
    );
    if (searchText !== lead.searchText) patch.searchText = searchText;
    if (Object.keys(patch).length > 0) {
      await ctx.db.insert("leadPlaceholderCleanups", {
        ...audit,
        table: "leads",
        docId: leadId,
        op: "patch",
        before: withoutSystemFields(lead),
        after: storedPatch({ ...patch, updatedAt: now }),
      });
      await ctx.db.patch("leads", leadId, { ...patch, updatedAt: now });
    }
    await refreshLeadCopies(ctx, tenantId, leadId);
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "lead",
      entityId: leadId,
      eventType: "lead.placeholders_removed",
      source: "system",
      metadata: {
        identifiersDeleted: current.placeholderIdentifiers.length,
        fieldsCleared: current.fields,
      },
      occurredAt: now,
    });
    log.info("lead_placeholder_cleanup.cleaned", {
      tenantId,
      leadId,
      identifiersDeleted: current.placeholderIdentifiers.length,
      fieldsCleared: current.fields,
    });
    return { identifiersDeleted: current.placeholderIdentifiers.length, fieldsCleared: current.fields };
  },
});

/**
 * Puts a cleaned lead back: re-creates its deleted identifiers and restores
 * the contact fields. Refuses if the lead's patched fields changed since, or
 * if another lead now holds one of the identifiers.
 */
export const undoLead = internalMutation({
  args: { tenantId: v.id("tenants"), leadId: v.id("leads") },
  returns: v.object({ identifiersRestored: v.number(), leadRestored: v.boolean() }),
  handler: async (ctx, { tenantId, leadId }) => {
    const rows = await ctx.db
      .query("leadPlaceholderCleanups")
      .withIndex("by_leadId_and_revertedAt", (q) => q.eq("leadId", leadId).eq("revertedAt", undefined))
      .take(IDENTIFIER_LIMIT + 2);
    if (rows.length === 0) throw new Error(`Lead ${leadId} has no cleanup to undo`);
    // cleanLead allows one pending cleanup, with a row per identifier and one for the lead.
    if (rows.length > IDENTIFIER_LIMIT + 1 || rows.some((row) => row.createdAt !== rows[0].createdAt))
      throw new Error(`Lead ${leadId}'s cleanup log isn't one cleanup`);
    if (rows.some((row) => row.tenantId !== tenantId)) throw new Error(`Lead ${leadId} not found`);
    const lead = await ctx.db.get("leads", leadId);
    if (!lead) throw new Error(`Lead ${leadId} not found`);

    const leadRow = rows.find((row) => row.table === "leads");
    const after = (leadRow?.after ?? {}) as Record<string, unknown>;
    const before = (leadRow?.before ?? {}) as Record<string, unknown>;
    for (const [field, value] of Object.entries(after)) {
      if (field === "updatedAt") continue;
      const currentValue = lead[field as keyof Doc<"leads">];
      if (JSON.stringify(currentValue ?? null) !== JSON.stringify(value)) {
        throw new Error(`Lead ${leadId}'s ${field} changed since the cleanup`);
      }
    }
    const identifierRows = rows.filter((row) => row.table === "leadIdentifiers");
    for (const row of identifierRows) {
      const identifier = row.before as Omit<Doc<"leadIdentifiers">, "_id" | "_creationTime">;
      const holders = await ctx.db
        .query("leadIdentifiers")
        .withIndex("by_tenantId_and_type_and_value", (q) =>
          q.eq("tenantId", tenantId).eq("type", identifier.type).eq("value", identifier.value),
        )
        .take(1);
      if (holders.length > 0) {
        throw new Error(`Lead ${holders[0].leadId} now holds a ${identifier.type} this cleanup removed`);
      }
    }

    const now = Date.now();
    for (const row of identifierRows) {
      await ctx.db.insert("leadIdentifiers", row.before as Omit<Doc<"leadIdentifiers">, "_id" | "_creationTime">);
    }
    if (leadRow) {
      await ctx.db.patch(
        "leads",
        leadId,
        Object.fromEntries(Object.keys(after).map((field) => [field, before[field]])),
      );
    }
    for (const row of rows) await ctx.db.patch("leadPlaceholderCleanups", row._id, { revertedAt: now });
    await refreshLeadCopies(ctx, tenantId, leadId);
    log.info("lead_placeholder_cleanup.undone", {
      tenantId,
      leadId,
      identifiersRestored: identifierRows.length,
    });
    return { identifiersRestored: identifierRows.length, leadRestored: leadRow !== undefined };
  },
});
