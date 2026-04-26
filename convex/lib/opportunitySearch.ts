import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { buildLeadSearchText } from "../leads/searchTextBuilder";
import { normalizeOpportunitySource } from "./sideDeals";

type ActivityShape = Pick<
  Doc<"opportunities">,
  "paymentReceivedAt" | "lostAt" | "latestMeetingAt" | "updatedAt" | "createdAt"
>;

function computeSearchActivityAt(opportunity: ActivityShape): number {
  return Math.max(
    opportunity.paymentReceivedAt ?? 0,
    opportunity.lostAt ?? 0,
    opportunity.latestMeetingAt ?? 0,
    opportunity.updatedAt,
    opportunity.createdAt,
  );
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

function dayKeyFromDate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function opportunityActivityKeys(timestamp: number): {
  activityDayKey: string;
  activityWeekKey: string;
  activityMonthKey: string;
} {
  const date = new Date(timestamp);
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);

  const week = new Date(day);
  week.setDate(week.getDate() - week.getDay());

  return {
    activityDayKey: dayKeyFromDate(day),
    activityWeekKey: dayKeyFromDate(week),
    activityMonthKey: `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`,
  };
}

function appendUnique(
  parts: string[],
  seen: Set<string>,
  value: string | undefined,
): void {
  const trimmed = value?.trim();
  if (!trimmed) {
    return;
  }

  const key = trimmed.toLowerCase();
  if (seen.has(key)) {
    return;
  }

  seen.add(key);
  parts.push(trimmed);
}

function buildOpportunitySearchText(
  lead: Doc<"leads"> | null,
  opportunity: Doc<"opportunities">,
): string {
  const parts: string[] = [];
  const seen = new Set<string>();

  appendUnique(parts, seen, lead?.searchText);
  if (lead) {
    appendUnique(parts, seen, buildLeadSearchText(lead));
  }
  appendUnique(parts, seen, opportunity.notes);
  appendUnique(parts, seen, opportunity.calendlyEventUri);
  appendUnique(parts, seen, opportunity._id);

  return parts.join(" ");
}

export async function upsertOpportunitySearchProjection(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
): Promise<void> {
  const opportunity = await ctx.db.get(opportunityId);
  if (!opportunity) {
    return;
  }

  const lead = await ctx.db.get(opportunity.leadId);
  const latestActivityAt =
    opportunity.latestActivityAt ?? computeSearchActivityAt(opportunity);
  const searchText = buildOpportunitySearchText(lead, opportunity);
  if (!searchText.trim()) {
    throw new Error(
      `Opportunity ${opportunityId} cannot be indexed without search text.`,
    );
  }

  const existing = await ctx.db
    .query("opportunitySearch")
    .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunityId))
    .unique();

  const projection = {
    tenantId: opportunity.tenantId,
    opportunityId,
    leadId: opportunity.leadId,
    assignedCloserId: opportunity.assignedCloserId,
    source: normalizeOpportunitySource(opportunity),
    status: opportunity.status,
    latestActivityAt,
    ...opportunityActivityKeys(latestActivityAt),
    searchText,
    updatedAt: Date.now(),
  };

  if (existing) {
    await ctx.db.patch(existing._id, projection);
    return;
  }

  await ctx.db.insert("opportunitySearch", projection);
}

export async function deleteOpportunitySearchProjection(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
): Promise<void> {
  const existing = await ctx.db
    .query("opportunitySearch")
    .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunityId))
    .unique();

  if (existing) {
    await ctx.db.delete(existing._id);
  }
}

export async function refreshOpportunitySearchForLead(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  leadId: Id<"leads">,
): Promise<void> {
  for await (const opportunity of ctx.db
    .query("opportunities")
    .withIndex("by_tenantId_and_leadId", (q) =>
      q.eq("tenantId", tenantId).eq("leadId", leadId),
    )) {
    await upsertOpportunitySearchProjection(ctx, opportunity._id);
  }
}
