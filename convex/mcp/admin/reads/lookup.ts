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
  partialReason,
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
};
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
    title: text(lead.fullName ?? "Unnamed person"),
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
    title: text(person.fullName ?? "Unnamed person"),
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
  const result: LookupItem = {
    kind: "meeting",
    id: meeting._id,
    title: text(meeting.leadName ?? "Unnamed person"),
    ids: {
      meetingId: meeting._id,
      opportunityId: deal._id,
      personId: deal.leadId,
      closerId: meeting.assignedCloserId,
    },
    state: meeting.status,
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
      (query !== undefined && !query.trim())
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
          r.name
            .toLocaleLowerCase()
            .includes(query!.trim().toLocaleLowerCase()),
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
        const p = await personItem(
          ctx,
          me,
          row,
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
      // Active people first, then customers; merged records never match.
      const candidates: Doc<"leads">[] = [];
      for (const status of ["active", "converted"] as const) {
        if (candidates.length > 10) break;
        candidates.push(
          ...(await ctx.db
            .query("leads")
            .withSearchIndex("search_leads", (q) =>
              q.search("searchText", query!.trim()).eq("tenantId", me.tenantId).eq("status", status),
            )
            .take(11 - candidates.length)),
        );
      }
      isPartial = candidates.length > 10;
      if (kind === "person") {
        const single = candidates.length === 1;
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
        for (const lead of candidates.slice(0, 10)) {
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
          for (const deal of deals.slice(0, 10)) {
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
    const fitted = fitRows(items);
    isPartial ||= fitted.capped;
    return {
      items: fitted.rows,
      isPartial,
      reason: partialReason(isPartial),
      timeZone: me.timeZone,
    };
  },
});
