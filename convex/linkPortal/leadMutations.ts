// NIM-17 Phase 5: internal mutations backing the DM closer portal lead
// surface (Initial Source / self-reported income / notes).
//
// Called only by the "use node" public actions in linkPortal/leadActions.ts.
// Tenant identity always comes from the verified session token; the
// client-chosen dmCloserId is validated as an active closer of the tenant
// (same trust level as copyMutations.insertCopyEvent). Writes are audited
// with the hashed session id, mirroring linkPortalCopyEvents.

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import {
  leadInitialSourceValidator,
  PORTAL_LEAD_INCOME_MAX,
  PORTAL_LEAD_NOTE_MAX_LENGTH,
} from "../lib/linkPortal/validators";
import {
  assertActivePortalSession,
  requirePortalDmCloser,
  requirePortalLead,
} from "./leadSession";

// Light write rate limit for portal writes (notes AND profile edits): per DM
// closer per minute, plus a tenant-wide flood guard, both computed from a
// single bounded index read over the relevant table's last-minute window.
const PORTAL_WRITE_RATE_WINDOW_MS = 60_000;
const PORTAL_WRITE_RATE_MAX_PER_DM_CLOSER = 10;
const PORTAL_WRITE_RATE_TENANT_FLOOD_LIMIT = 50;

// Shared window check for portal write rate limiting. Callers read the last
// minute of rows via the table's by_tenantId_and_createdAt index (bounded at
// PORTAL_WRITE_RATE_TENANT_FLOOD_LIMIT) and pass them here. A full window is
// treated as a tenant-wide flood regardless of which closer wrote the rows.
function evaluatePortalWriteRateLimit(
  recentRows: Array<{ dmCloserId?: Id<"dmClosers"> }>,
  dmCloserId: Id<"dmClosers">,
): {
  limited: boolean;
  dmCloserRecentCount: number;
  tenantRecentCount: number;
} {
  const dmCloserRecentCount = recentRows.filter(
    (row) => row.dmCloserId === dmCloserId,
  ).length;
  return {
    limited:
      dmCloserRecentCount >= PORTAL_WRITE_RATE_MAX_PER_DM_CLOSER ||
      recentRows.length >= PORTAL_WRITE_RATE_TENANT_FLOOD_LIMIT,
    dmCloserRecentCount,
    tenantRecentCount: recentRows.length,
  };
}

export const updateLeadProfileForSession = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    publicSlug: v.string(),
    sessionVersion: v.number(),
    sessionIdHash: v.string(),
    dmCloserId: v.id("dmClosers"),
    leadId: v.id("leads"),
    // undefined leaves the field untouched; null clears it.
    initialSource: v.optional(v.union(leadInitialSourceValidator, v.null())),
    selfReportedIncome: v.optional(v.union(v.number(), v.null())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertActivePortalSession(ctx, args);
    await requirePortalDmCloser(ctx, {
      tenantId: args.tenantId,
      dmCloserId: args.dmCloserId,
    });
    await requirePortalLead(ctx, {
      tenantId: args.tenantId,
      leadId: args.leadId,
    });

    if (args.initialSource === undefined && args.selfReportedIncome === undefined) {
      return null;
    }

    // Bound the client-supplied income before it touches the document:
    // finite, non-negative, sane ceiling.
    if (typeof args.selfReportedIncome === "number") {
      if (
        !Number.isFinite(args.selfReportedIncome) ||
        args.selfReportedIncome < 0 ||
        args.selfReportedIncome > PORTAL_LEAD_INCOME_MAX
      ) {
        throw new Error("Income value is out of range.");
      }
    }

    // Rate limit: same window pattern as the note limiter below, computed
    // over the linkPortalLeadEdits audit table (one bounded index read, both
    // ends of the range bounded).
    const now = Date.now();
    const recentEdits = await ctx.db
      .query("linkPortalLeadEdits")
      .withIndex("by_tenantId_and_createdAt", (q) =>
        q
          .eq("tenantId", args.tenantId)
          .gte("createdAt", now - PORTAL_WRITE_RATE_WINDOW_MS)
          .lte("createdAt", now),
      )
      .order("desc")
      .take(PORTAL_WRITE_RATE_TENANT_FLOOD_LIMIT);
    const editRate = evaluatePortalWriteRateLimit(recentEdits, args.dmCloserId);
    if (editRate.limited) {
      console.warn("[LinkPortal:Leads] profile edit rate limit hit", {
        tenantId: args.tenantId,
        leadId: args.leadId,
        dmCloserId: args.dmCloserId,
        sessionIdHash: args.sessionIdHash,
        dmCloserRecentCount: editRate.dmCloserRecentCount,
        tenantRecentCount: editRate.tenantRecentCount,
      });
      throw new Error("Too many edits in a short time. Try again in a minute.");
    }

    const patch: {
      initialSource?: "cta" | "inbound" | "wechat" | undefined;
      selfReportedIncome?: number | undefined;
      updatedAt: number;
    } = { updatedAt: now };
    const changes: Record<string, string | number | null> = {};

    if (args.initialSource !== undefined) {
      // Patching to undefined removes the optional field (null clears).
      patch.initialSource = args.initialSource ?? undefined;
      changes.initialSource = args.initialSource;
    }
    if (args.selfReportedIncome !== undefined) {
      patch.selfReportedIncome = args.selfReportedIncome ?? undefined;
      changes.selfReportedIncome = args.selfReportedIncome;
    }

    await ctx.db.patch(args.leadId, patch);

    // Durable audit row (also the rate-limit window source above); the
    // console log below stays for structured log tailing.
    await ctx.db.insert("linkPortalLeadEdits", {
      tenantId: args.tenantId,
      leadId: args.leadId,
      dmCloserId: args.dmCloserId,
      sessionIdHash: args.sessionIdHash,
      createdAt: now,
      changedFields: Object.keys(changes),
    });

    console.log("[LinkPortal:Leads] lead profile updated", {
      tenantId: args.tenantId,
      leadId: args.leadId,
      dmCloserId: args.dmCloserId,
      sessionIdHash: args.sessionIdHash,
      changes,
    });

    return null;
  },
});

export const insertLeadNoteForSession = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    publicSlug: v.string(),
    sessionVersion: v.number(),
    sessionIdHash: v.string(),
    dmCloserId: v.id("dmClosers"),
    leadId: v.id("leads"),
    content: v.string(),
  },
  returns: v.id("leadNotes"),
  handler: async (ctx, args) => {
    await assertActivePortalSession(ctx, args);
    await requirePortalDmCloser(ctx, {
      tenantId: args.tenantId,
      dmCloserId: args.dmCloserId,
    });
    await requirePortalLead(ctx, {
      tenantId: args.tenantId,
      leadId: args.leadId,
    });

    const content = args.content.trim();
    if (content.length < 1 || content.length > PORTAL_LEAD_NOTE_MAX_LENGTH) {
      throw new Error(
        `Note must be between 1 and ${PORTAL_LEAD_NOTE_MAX_LENGTH} characters.`,
      );
    }

    // Rate limit: one bounded read over the tenant's most recent notes in the
    // last minute via by_tenantId_and_createdAt (both ends of the range
    // bounded), evaluated by the shared window check. Only dm_closer-authored
    // notes carry a dmCloserId, so matching on dmCloserId alone is exact.
    const now = Date.now();
    const recentNotes = await ctx.db
      .query("leadNotes")
      .withIndex("by_tenantId_and_createdAt", (q) =>
        q
          .eq("tenantId", args.tenantId)
          .gte("createdAt", now - PORTAL_WRITE_RATE_WINDOW_MS)
          .lte("createdAt", now),
      )
      .order("desc")
      .take(PORTAL_WRITE_RATE_TENANT_FLOOD_LIMIT);

    const noteRate = evaluatePortalWriteRateLimit(recentNotes, args.dmCloserId);
    if (noteRate.limited) {
      console.warn("[LinkPortal:Leads] note rate limit hit", {
        tenantId: args.tenantId,
        leadId: args.leadId,
        dmCloserId: args.dmCloserId,
        sessionIdHash: args.sessionIdHash,
        dmCloserRecentCount: noteRate.dmCloserRecentCount,
        tenantRecentCount: noteRate.tenantRecentCount,
      });
      throw new Error("Too many notes in a short time. Try again in a minute.");
    }

    const noteId = await ctx.db.insert("leadNotes", {
      tenantId: args.tenantId,
      leadId: args.leadId,
      content,
      createdAt: now,
      authorKind: "dm_closer",
      dmCloserId: args.dmCloserId,
    });

    console.log("[LinkPortal:Leads] lead note added", {
      tenantId: args.tenantId,
      leadId: args.leadId,
      dmCloserId: args.dmCloserId,
      sessionIdHash: args.sessionIdHash,
      noteId,
      contentLength: content.length,
    });

    return noteId;
  },
});
