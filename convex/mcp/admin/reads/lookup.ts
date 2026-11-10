import { v } from "convex/values";
import type { Doc, Id } from "../../../_generated/dataModel";
import { internalQuery, type QueryCtx } from "../../../_generated/server";
import {
  readLiveQueryRows,
  createLiveReadState,
} from "../../../lib/liveQueryBounds";
import { buildAdminPerson } from "../../tools/person";
import { buildMeetingDetail } from "../../../closer/meetingDetail";
import { buildPaymentDetail } from "../../../billing/queriesCore";
import { buildDirectory } from "../../../team/directoryCore";
import { latestCallNote } from "../../noteRead";
import { mcpCallerValidator, requireMcpAdmin, loadInTenant } from "../../guard";
import { expectedError } from "../../../lib/observability/errors";
import { formatLocal } from "../../time";
import { meetingAttendanceDisplay } from "../../../../lib/status-config";
import {
  getProjectedRowForLead,
  resolveDirectEntityIdentifier,
} from "../../../leadCustomers/identifierResolution";
import { followMergeChain } from "../../../leads/identityResolution";
import { lookupHandle } from "../../../leadGen/handleLookup";
import {
  isPlaceholderEmail,
  normalizeEmail,
  normalizePhone,
} from "../../../lib/normalization";
import {
  type Admin,
  text,
  textValidator,
  tenantId,
  notFound,
  paymentActions,
  meetingActions,
  dealActions,
  paths,
  fitRows,
} from "./common";

export const lookupKind = v.union(
  v.literal("person"),
  v.literal("deal"),
  v.literal("meeting"),
  v.literal("payment"),
  v.literal("team_member"),
);
export const lookupArgs = {
  kind: lookupKind,
  query: v.optional(v.string()),
  id: v.optional(v.string()),
  includeContact: v.optional(v.boolean()),
  includeNotes: v.optional(v.boolean()),
};
type Kind = "person" | "deal" | "meeting" | "payment" | "team_member";
const relatedValidator = v.object({
  id: v.string(),
  state: v.string(),
  allowedActions: v.array(v.string()),
  openInMagnus: v.string(),
});
export const lookupItemValidator = v.object({
  kind: lookupKind,
  id: v.string(),
  title: textValidator,
  ids: v.record(v.string(), v.union(v.string(), v.null())),
  state: v.string(),
  allowedActions: v.array(v.string()),
  openInMagnus: v.string(),
  contact: v.optional(
    v.object({
      email: v.union(v.string(), v.null()),
      phone: v.union(v.string(), v.null()),
    }),
  ),
  notes: v.optional(v.array(textValidator)),
  related: v.optional(v.array(relatedValidator)),
  amountMinor: v.optional(v.number()),
  currency: v.optional(v.string()),
  scheduledAt: v.optional(v.string()),
  isActive: v.optional(v.boolean()),
  lifecycle: v.optional(v.string()),
  latestActivityAt: v.optional(v.string()),
  dealCount: v.optional(v.number()),
});
type LookupItem = {
  kind: Kind;
  id: string;
  title: ReturnType<typeof text>;
  ids: Record<string, string | null>;
  state: string;
  allowedActions: string[];
  openInMagnus: string;
  contact?: { email: string | null; phone: string | null };
  notes?: ReturnType<typeof text>[];
  related?: Array<{
    id: string;
    state: string;
    allowedActions: string[];
    openInMagnus: string;
  }>;
  amountMinor?: number;
  currency?: string;
  scheduledAt?: string;
  isActive?: boolean;
  lifecycle?: string;
  latestActivityAt?: string;
  dealCount?: number;
};

function foldedName(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

/** Stable within each tier; only real names rank, never contact fallbacks. */
export function rankPersonCandidates<T extends { fullName?: string }>(
  rows: T[],
  query: string,
): T[] {
  const term = foldedName(query);
  const tokens = term.split(" ");
  const tier = (row: T) => {
    const name = foldedName(row.fullName ?? "");
    if (!name) return 4;
    if (name === term) return 0;
    if (tokens.every((token) => name.includes(token))) return 1;
    if (tokens.some((token) => name.includes(token))) return 2;
    return 3;
  };
  return [...rows].sort((a, b) => tier(a) - tier(b));
}

async function findPeople(ctx: QueryCtx, me: Admin, term: string) {
  const candidates: Doc<"leads">[] = [];
  const add = async (leadId: Id<"leads">) => {
    const lead = await ctx.db.get("leads", leadId);
    if (!lead || lead.tenantId !== me.tenantId) return;
    const person = await followMergeChain(ctx, lead);
    if (person && !candidates.some((row) => row._id === person._id))
      candidates.push(person);
  };
  const leadId = ctx.db.normalizeId("leads", term);
  const dealId = ctx.db.normalizeId("opportunities", term);
  const meetingId = ctx.db.normalizeId("meetings", term);
  if (leadId || dealId || meetingId) {
    const direct = await resolveDirectEntityIdentifier(ctx, me.tenantId, term);
    if (direct) {
      await add(direct.row.leadId);
      return {
        candidates,
        capped: false,
        selectedOpportunityId: direct.selectedOpportunityId,
        selectedMeetingId: direct.selectedMeetingId,
      };
    }
    // IDs still resolve while a person's search projection is missing.
    if (leadId) await add(leadId);
    const meeting = meetingId ? await ctx.db.get("meetings", meetingId) : null;
    const selectedDealId = dealId ??
      (meeting?.tenantId === me.tenantId ? meeting.opportunityId : null);
    const deal = selectedDealId
      ? await ctx.db.get("opportunities", selectedDealId)
      : null;
    if (deal?.tenantId === me.tenantId) await add(deal.leadId);
    return {
      candidates,
      capped: false,
      selectedOpportunityId: deal?.tenantId === me.tenantId ? deal._id : undefined,
      selectedMeetingId: meeting?.tenantId === me.tenantId ? meeting._id : undefined,
    };
  }
  const email = normalizeEmail(term);
  const looksLikePhone = /^[+\d().\s-]+$/.test(term);
  const phone = looksLikePhone ? normalizePhone(term) : undefined;
  if (email || phone) {
    if (email && isPlaceholderEmail(email)) return { candidates, capped: false };
    const identifiers = await ctx.db
      .query("leadIdentifiers")
      .withIndex("by_tenantId_and_type_and_value", (q) =>
        q.eq("tenantId", me.tenantId)
          .eq("type", email ? "email" : "phone")
          .eq("value", email ?? phone!),
      )
      .take(17);
    for (const identifier of identifiers) await add(identifier.leadId);
    return { candidates, capped: identifiers.length === 17 };
  }
  const handle = await lookupHandle(ctx, me.tenantId, term);
  if (handle.valid && handle.lead) {
    await add(handle.lead._id);
    return { candidates, capped: false };
  }
  // A known conflict or explicit identifier must never fall through to fuzzy search.
  if (
    (handle.valid && (handle.verdict === "conflict" || /[._]/.test(term))) ||
    /[@/]/.test(term) || looksLikePhone
  ) {
    return { candidates, capped: false };
  }
  const visible = await ctx.db
    .query("leadCustomerSearchRows")
    .withSearchIndex("search_lead_customer_entities", (q) =>
      q.search("searchText", term)
        .eq("tenantId", me.tenantId)
        .eq("isSearchVisible", true),
    )
    .take(50);
  const prospects = visible.length < 10
    ? await ctx.db
        .query("leadCustomerSearchRows")
        .withSearchIndex("search_lead_customer_entities", (q) =>
          q.search("searchText", term)
            .eq("tenantId", me.tenantId)
            .eq("isSearchVisible", false)
            .eq("lifecycle", "prospect"),
        )
        .take(50)
    : [];
  // Rank the visible group first; prospects only fill the remaining places.
  for (const group of [visible, prospects]) {
    const people: Doc<"leads">[] = [];
    for (const row of group) {
      if (row.lifecycle === "merged") continue;
      const lead = await ctx.db.get("leads", row.leadId);
      if (lead && lead.tenantId === me.tenantId && lead.status !== "merged")
        people.push(lead);
    }
    candidates.push(...rankPersonCandidates(people, term));
  }
  return { candidates, capped: visible.length === 50 || prospects.length === 50 };
}
async function notesFor(ctx: QueryCtx, me: Admin, dealId: Id<"opportunities">) {
  const note = await latestCallNote(ctx, me.tenantId, dealId);
  return note
    ? [
        note.currentSituation,
        note.goal,
        note.bottleneck,
        note.objection,
        note.nextAction,
      ]
        .filter((s): s is string => Boolean(s))
        .map((s) => text(s, "closer_agent", 1000))
    : [];
}
async function personItem(
  ctx: QueryCtx,
  me: Admin,
  lead: Doc<"leads">,
  detail: boolean,
  contact: boolean,
  notes: boolean,
): Promise<{ item: LookupItem; capped: boolean }> {
  const base: LookupItem = {
    kind: "person",
    id: lead._id,
    title: text(lead.fullName?.trim() || "Unnamed person"),
    ids: { personId: lead._id },
    state: lead.status,
    allowedActions: ["magnus_lookup"],
    openInMagnus: paths.person(lead._id),
  };
  if (!detail || lead.status === "merged") return { item: base, capped: false };
  const p = await buildAdminPerson(ctx, me, lead._id, contact);
  if (p.contact)
    base.contact = { email: p.contact.email, phone: p.contact.phone };
  base.related = p.deals
    .slice(0, 10)
    .map((d) => ({
      id: d.opportunityId,
      state: `${d.stage}:${d.outcome}`,
      allowedActions: ["magnus_lookup"],
      openInMagnus: paths.deal(d.opportunityId),
    }));
  if (notes)
    base.notes = p.deals
      .slice(0, 10)
      .flatMap((d) =>
        d.latestCallNote
          ? [
              d.latestCallNote.currentSituation,
              d.latestCallNote.goal,
              d.latestCallNote.bottleneck,
              d.latestCallNote.objection,
              d.latestCallNote.nextAction,
            ]
              .filter((s): s is string => Boolean(s))
              .map((s) => text(s, "closer_agent", 1000))
          : [],
      )
      .slice(0, 6);
  return { item: base, capped: p.isPartial || p.deals.length > 10 };
}
async function dealItem(
  ctx: QueryCtx,
  me: Admin,
  deal: Doc<"opportunities">,
  contact: boolean,
  notes: boolean,
): Promise<LookupItem> {
  const person = await loadInTenant(ctx, me, "leads", deal.leadId);
  return {
    kind: "deal",
    id: deal._id,
    title: text(person.fullName?.trim() || "Unnamed person"),
    ids: {
      opportunityId: deal._id,
      personId: person._id,
      closerId: deal.assignedCloserId ?? null,
      meetingId: deal.latestMeetingId ?? null,
    },
    state: `${deal.stage}:${deal.outcome}`,
    allowedActions: dealActions(me, deal),
    openInMagnus: paths.deal(deal._id),
    ...(contact
      ? {
          contact: { email: person.email ?? null, phone: person.phone ?? null },
        }
      : {}),
    ...(notes ? { notes: await notesFor(ctx, me, deal._id) } : {}),
  };
}
async function meetingItem(
  ctx: QueryCtx,
  me: Admin,
  meeting: Doc<"meetings">,
  detail: boolean,
  contact: boolean,
  notes: boolean,
): Promise<LookupItem> {
  const deal = await loadInTenant(
    ctx,
    me,
    "opportunities",
    meeting.opportunityId,
  );
  const person = await loadInTenant(ctx, me, "leads", deal.leadId);
  const result: LookupItem = {
    kind: "meeting",
    id: meeting._id,
    title: text(person.fullName?.trim() || meeting.leadName || "Unnamed person"),
    ids: {
      meetingId: meeting._id,
      opportunityId: deal._id,
      personId: deal.leadId,
      closerId: meeting.assignedCloserId,
    },
    state: meetingAttendanceDisplay(meeting, Date.now()),
    scheduledAt: formatLocal(meeting.scheduledAt, me.timeZone),
    allowedActions: meetingActions(me, meeting, deal),
    openInMagnus: paths.meeting(meeting._id),
  };
  if (detail) {
    const full = await buildMeetingDetail(ctx, me, meeting._id);
    if (contact)
      result.contact = {
        email: full.lead.email ?? null,
        phone: full.lead.phone ?? null,
      };
    if (notes) result.notes = await notesFor(ctx, me, deal._id);
  }
  return result;
}
async function paymentItem(
  ctx: QueryCtx,
  me: Admin,
  payment: Doc<"paymentRecords">,
  detail: boolean,
  contact: boolean,
  notes: boolean,
): Promise<LookupItem> {
  const full = detail
    ? await buildPaymentDetail(ctx, me.tenantId, payment._id)
    : null;
  const deal = payment.opportunityId
    ? await loadInTenant(ctx, me, "opportunities", payment.opportunityId)
    : null;
  const person = deal
    ? await loadInTenant(ctx, me, "leads", deal.leadId)
    : null;
  return {
    kind: "payment",
    id: payment._id,
    title: text(person?.fullName ?? "Payment"),
    ids: {
      paymentId: payment._id,
      opportunityId: deal?._id ?? null,
      personId: person?._id ?? null,
      meetingId: payment.meetingId ?? null,
      closerId: payment.attributedCloserId ?? null,
    },
    state: payment.status,
    amountMinor: payment.amountMinor,
    currency: payment.currency,
    allowedActions: paymentActions(me, payment),
    openInMagnus: paths.payment(payment._id),
    ...(contact && full
      ? { contact: { email: full.customer.email, phone: full.customer.phone } }
      : {}),
    ...(notes && full
      ? {
          notes: full.payment.note
            ? [
                text(
                  full.payment.note,
                  payment.agentClient ? "closer_agent" : "admin",
                  1000,
                ),
              ]
            : [],
        }
      : {}),
  };
}
export const run = internalQuery({
  args: { caller: mcpCallerValidator, ...lookupArgs },
  returns: v.object({
    items: v.array(lookupItemValidator),
    isPartial: v.boolean(),
    reason: v.union(v.string(), v.null()),
    timeZone: v.string(),
  }),
  handler: async (
    ctx,
    { caller, kind, query, id, includeContact, includeNotes },
  ) => {
    const me = await requireMcpAdmin(ctx, caller);
    if (
      Number(id !== undefined) + Number(query !== undefined) !== 1 ||
      (query !== undefined && !query.trim()) ||
      (id !== undefined && !id.trim())
    )
      throw expectedError(
        "mcp.lookup_selector",
        "Pass either an ID or a name to find.",
      );
    let items: LookupItem[] = [],
      isPartial = false;
    if (kind === "team_member") {
      const directory = await buildDirectory(ctx, me.tenantId);
      let matches = directory.members;
      if (id) {
        const memberId = ctx.db.normalizeId("teamMembers", id),
          userId = ctx.db.normalizeId("users", id);
        if (memberId) await loadInTenant(ctx, me, "teamMembers", memberId);
        else if (userId) await loadInTenant(ctx, me, "users", userId);
        else notFound();
        matches = matches.filter(
          (r) => r.teamMemberId === id || r.login?.userId === id,
        );
      } else
        matches = matches.filter((r) =>
          foldedName(r.name).includes(foldedName(query!)),
        );
      isPartial = directory.capped || matches.length > 10;
      items = matches
        .slice(0, 10)
        .map((r) => ({
          kind,
          id: r.teamMemberId ?? r.login?.userId ?? r.key,
          title: text(
            r.name.includes("@") ? "Unnamed member" : r.name,
            "admin",
          ),
          ids: {
            teamMemberId: r.teamMemberId,
            userId: r.login?.userId ?? null,
          },
          state: r.login
            ? r.login.isActive
              ? "active"
              : "inactive"
            : "no_login",
          isActive: r.login?.isActive ?? false,
          allowedActions: [
            "magnus_lookup",
            ...(r.login?.role === "closer" &&
            r.login.isActive &&
            me.writeFamilies.includes("coverage")
              ? ["magnus_cover_closer"]
              : []),
          ],
          openInMagnus: paths.team(),
          ...(matches.length === 1 && includeContact
            ? { contact: { email: r.login?.email ?? null, phone: null } }
            : {}),
        }));
    } else if (id) {
      if (kind === "person") {
        const row = await loadInTenant(
          ctx,
          me,
          "leads",
          await tenantId(ctx, me, "leads", id),
        );
        const person = await followMergeChain(ctx, row);
        if (!person) notFound();
        const p = await personItem(
          ctx,
          me,
          person,
          true,
          !!includeContact,
          !!includeNotes,
        );
        items = [p.item];
        isPartial = p.capped;
      }
      if (kind === "deal")
        items = [
          await dealItem(
            ctx,
            me,
            await loadInTenant(
              ctx,
              me,
              "opportunities",
              await tenantId(ctx, me, "opportunities", id),
            ),
            !!includeContact,
            !!includeNotes,
          ),
        ];
      if (kind === "meeting")
        items = [
          await meetingItem(
            ctx,
            me,
            await loadInTenant(
              ctx,
              me,
              "meetings",
              await tenantId(ctx, me, "meetings", id),
            ),
            true,
            !!includeContact,
            !!includeNotes,
          ),
        ];
      if (kind === "payment")
        items = [
          await paymentItem(
            ctx,
            me,
            await loadInTenant(
              ctx,
              me,
              "paymentRecords",
              await tenantId(ctx, me, "paymentRecords", id),
            ),
            true,
            !!includeContact,
            !!includeNotes,
          ),
        ];
    } else {
      const found = await findPeople(ctx, me, query!.trim());
      const { candidates } = found;
      isPartial = found.capped || candidates.length > 10;
      if (kind === "person") {
        const single = candidates.length === 1 && !isPartial;
        for (const lead of candidates.slice(0, 10)) {
          const p = await personItem(
            ctx,
            me,
            lead,
            single,
            single && !!includeContact,
            single && !!includeNotes,
          );
          items.push(p.item);
          isPartial ||= p.capped;
        }
      } else {
        const state = createLiveReadState();
        const deals: Doc<"opportunities">[] = [];
        if (found.selectedOpportunityId) {
          deals.push(await loadInTenant(ctx, me, "opportunities", found.selectedOpportunityId));
        } else for (const lead of candidates.slice(0, 10)) {
          const scan = await readLiveQueryRows(
            ctx.db
              .query("opportunities")
              .withIndex("by_tenantId_and_leadId", (q) =>
                q.eq("tenantId", me.tenantId).eq("leadId", lead._id),
              ),
            11,
            state,
          );
          deals.push(...scan.rows);
          isPartial ||= scan.capped;
          if (deals.length > 10) {
            isPartial = true;
            break;
          }
        }
        if (kind === "deal")
          items = await Promise.all(
            deals
              .slice(0, 10)
              .map((r) =>
                dealItem(
                  ctx,
                  me,
                  r,
                  deals.length === 1 && !isPartial && !!includeContact,
                  deals.length === 1 && !isPartial && !!includeNotes,
                ),
              ),
          );
        else if (kind === "meeting") {
          const rows: Doc<"meetings">[] = [];
          if (found.selectedMeetingId) {
            rows.push(await loadInTenant(ctx, me, "meetings", found.selectedMeetingId));
          } else for (const deal of deals.slice(0, 10)) {
            const scan = await readLiveQueryRows(
              ctx.db
                .query("meetings")
                .withIndex("by_opportunityId_and_scheduledAt", (q) =>
                  q.eq("opportunityId", deal._id),
                )
                .order("desc"),
              11,
              state,
            );
            rows.push(...scan.rows.filter((r) => r.tenantId === me.tenantId));
            isPartial ||= scan.capped;
            if (rows.length > 10) {
              isPartial = true;
              break;
            }
          }
          const single = rows.length === 1 && !isPartial;
          items = await Promise.all(
            rows
              .slice(0, 10)
              .map((r) =>
                meetingItem(
                  ctx,
                  me,
                  r,
                  single,
                  single && !!includeContact,
                  single && !!includeNotes,
                ),
              ),
          );
        } else {
          const rows: Doc<"paymentRecords">[] = [];
          for (const deal of deals.slice(0, 10)) {
            const scan = await readLiveQueryRows(
              ctx.db
                .query("paymentRecords")
                .withIndex("by_opportunityId_and_recordedAt", (q) =>
                  q.eq("opportunityId", deal._id),
                )
                .order("desc"),
              11,
              state,
            );
            rows.push(...scan.rows.filter((r) => r.tenantId === me.tenantId));
            isPartial ||= scan.capped;
            if (rows.length > 10) {
              isPartial = true;
              break;
            }
          }
          const single = rows.length === 1 && !isPartial;
          items = await Promise.all(
            rows
              .slice(0, 10)
              .map((r) =>
                paymentItem(
                  ctx,
                  me,
                  r,
                  single,
                  single && !!includeContact,
                  single && !!includeNotes,
                ),
              ),
          );
        }
      }
    }
    if (id && !items.length) notFound();
    for (const item of items) {
      if (item.title.text !== "Unnamed person" || !item.ids.personId) continue;
      const personId = ctx.db.normalizeId("leads", item.ids.personId);
      if (!personId) continue;
      const row = await getProjectedRowForLead(ctx, me.tenantId, personId);
      if (row && row.lifecycle !== "merged") {
        item.lifecycle = row.lifecycle;
        item.latestActivityAt = formatLocal(row.latestActivityAt, me.timeZone);
        item.dealCount = row.opportunityCount;
      }
    }
    const fitted = fitRows(items);
    isPartial ||= fitted.capped;
    return {
      items: fitted.rows,
      isPartial,
      reason: isPartial
        ? "Results are limited. Narrow the query or open Magnus to see more."
        : null,
      timeZone: me.timeZone,
    };
  },
});
