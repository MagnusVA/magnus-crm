// NIM-17 Phase 5: internal queries backing the DM closer portal lead surface.
//
// Called only by the "use node" public actions in linkPortal/leadActions.ts,
// which verify the signed portal session token and pass the tenant identity
// from the token — never from client args.

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalQuery } from "../_generated/server";
import {
  isPortalSearchTermPiiProbe,
  PORTAL_LEAD_NOTE_COUNT_CAP,
  type PortalLeadNoteRow,
  type PortalLeadSearchRow,
  portalLeadNoteRowValidator,
  portalLeadSearchRowValidator,
} from "../lib/linkPortal/validators";
import {
  assertActivePortalSession,
  portalLeadDisplayName,
  requirePortalLead,
} from "./leadSession";

const SEARCH_RESULT_LIMIT = 20;
const NOTES_RESULT_LIMIT = 50;
// Raw rows scanned per lead for the "20+" note count; must comfortably exceed
// PORTAL_LEAD_NOTE_COUNT_CAP + 1 so soft-deleted rows can't deflate the count.
const NOTE_COUNT_SCAN_LIMIT = 60;

export const searchLeadsForSession = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    publicSlug: v.string(),
    sessionVersion: v.number(),
    searchTerm: v.string(),
  },
  returns: v.array(portalLeadSearchRowValidator),
  handler: async (ctx, args): Promise<PortalLeadSearchRow[]> => {
    await assertActivePortalSession(ctx, args);

    // Anti-enumeration: require a minimum query length. Also enforced in the
    // public action; double-guarded here since this is the authoritative read.
    const trimmed = args.searchTerm.trim();
    if (trimmed.length < 2) {
      return [];
    }

    // PII probe prevention on this shared-password surface: the search_leads
    // index covers email/phone via leads.searchText, so email/phone-shaped
    // terms would let a shared-password holder confirm "does jane@x.com
    // exist". Name/handle search only (also enforced in the public action).
    if (isPortalSearchTermPiiProbe(trimmed)) {
      return [];
    }

    // Merged leads are excluded. The search index filters on a single status
    // value, so run one bounded search per visible status and combine.
    const [activeLeads, convertedLeads] = await Promise.all([
      ctx.db
        .query("leads")
        .withSearchIndex("search_leads", (q) =>
          q
            .search("searchText", trimmed)
            .eq("tenantId", args.tenantId)
            .eq("status", "active"),
        )
        .take(SEARCH_RESULT_LIMIT),
      ctx.db
        .query("leads")
        .withSearchIndex("search_leads", (q) =>
          q
            .search("searchText", trimmed)
            .eq("tenantId", args.tenantId)
            .eq("status", "converted"),
        )
        .take(SEARCH_RESULT_LIMIT),
    ]);

    const leads = [...activeLeads, ...convertedLeads].slice(
      0,
      SEARCH_RESULT_LIMIT,
    );

    const rows = await Promise.all(
      leads.map(async (lead): Promise<PortalLeadSearchRow | null> => {
        if (lead.status !== "active" && lead.status !== "converted") {
          return null;
        }

        // Bounded note count: soft-deleted rows are filtered AFTER the read,
        // so reading only cap + 1 raw rows would deflate the count below the
        // cap whenever deleted rows land in that window. Read a larger (still
        // bounded) slice, filter, then cap to cap + 1 — the UI renders any
        // value past the cap as "20+".
        const recentNotes = await ctx.db
          .query("leadNotes")
          .withIndex("by_tenantId_and_leadId", (q) =>
            q.eq("tenantId", args.tenantId).eq("leadId", lead._id),
          )
          .order("desc")
          .take(NOTE_COUNT_SCAN_LIMIT);
        const visibleNotes = recentNotes.filter(
          (note) => note.deletedAt === undefined,
        );

        return {
          leadId: lead._id,
          displayName: portalLeadDisplayName(lead),
          socialHandles: (lead.socialHandles ?? []).map((handle) => ({
            type: handle.type,
            handle: handle.handle,
          })),
          status: lead.status,
          initialSource: lead.initialSource ?? null,
          selfReportedIncome: lead.selfReportedIncome ?? null,
          noteCount: Math.min(
            visibleNotes.length,
            PORTAL_LEAD_NOTE_COUNT_CAP + 1,
          ),
          lastNoteAt: visibleNotes[0]?.createdAt ?? null,
        };
      }),
    );

    const filteredRows = rows.filter(
      (row): row is PortalLeadSearchRow => row !== null,
    );

    console.log("[LinkPortal:Leads] searchLeadsForSession completed", {
      tenantId: args.tenantId,
      searchTermLength: trimmed.length,
      resultCount: filteredRows.length,
    });

    return filteredRows;
  },
});

export const listLeadNotesForSession = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    publicSlug: v.string(),
    sessionVersion: v.number(),
    leadId: v.id("leads"),
  },
  returns: v.array(portalLeadNoteRowValidator),
  handler: async (ctx, args): Promise<PortalLeadNoteRow[]> => {
    await assertActivePortalSession(ctx, args);
    await requirePortalLead(ctx, {
      tenantId: args.tenantId,
      leadId: args.leadId,
    });

    const notes = await ctx.db
      .query("leadNotes")
      .withIndex("by_tenantId_and_leadId", (q) =>
        q.eq("tenantId", args.tenantId).eq("leadId", args.leadId),
      )
      .order("desc")
      .take(NOTES_RESULT_LIMIT);
    const visibleNotes = notes.filter((note) => note.deletedAt === undefined);

    // Batch-resolve DM closer labels. Workspace-authored notes deliberately
    // resolve to the generic "Team" label — no user names on the shared
    // portal surface.
    //
    // PII forward-guard: today only portal (dm_closer) notes are ever
    // written, so collapsing authorKind "user" to "Team" is safe. If
    // workspace-authored notes ever become writable, they may contain
    // internal-only content — add a per-note visibility flag and filter here
    // BEFORE exposing them to this shared-password portal surface.
    const dmCloserIds = [
      ...new Set(
        visibleNotes
          .map((note) => note.dmCloserId)
          .filter((id): id is Id<"dmClosers"> => id !== undefined),
      ),
    ];
    const dmClosers = await Promise.all(
      dmCloserIds.map(async (dmCloserId) => ({
        dmCloserId,
        dmCloser: await ctx.db.get(dmCloserId),
      })),
    );
    const dmCloserLabelById = new Map<Id<"dmClosers">, string>(
      dmClosers.map(({ dmCloserId, dmCloser }) => [
        dmCloserId,
        dmCloser && dmCloser.tenantId === args.tenantId
          ? dmCloser.displayName
          : "DM closer",
      ]),
    );

    return visibleNotes.map(
      (note): PortalLeadNoteRow => ({
        noteId: note._id,
        content: note.content,
        createdAt: note.createdAt,
        authorKind: note.authorKind,
        authorLabel:
          note.authorKind === "dm_closer"
            ? (note.dmCloserId
                ? dmCloserLabelById.get(note.dmCloserId)
                : undefined) ?? "DM closer"
            : "Team",
      }),
    );
  },
});
