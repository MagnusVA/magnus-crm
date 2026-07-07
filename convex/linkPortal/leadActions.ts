"use node";

// NIM-17 Phase 5: public portal actions for the DM closer lead surface.
//
// Follows the established portal auth pattern (portalActions.ts /
// copyActions.ts): each public action verifies the signed session token,
// checks the slug binding, then calls an internal query/mutation with the
// tenant identity taken from the token — never from client args. Writes carry
// the hashed session id for auditing, mirroring recordCopyEvent.

import { createHash } from "node:crypto";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action } from "../_generated/server";
import {
  isPortalSearchTermPiiProbe,
  leadInitialSourceValidator,
  type PortalLeadNoteRow,
  type PortalLeadSearchRow,
  portalLeadNoteRowValidator,
  portalLeadSearchRowValidator,
} from "../lib/linkPortal/validators";
import { verifyPortalSessionToken } from "./sessionToken";

function hashSessionId(jti: string) {
  return createHash("sha256").update(jti).digest("base64url");
}

export const searchPortalLeads = action({
  args: {
    portalSlug: v.string(),
    sessionToken: v.string(),
    searchTerm: v.string(),
  },
  returns: v.array(portalLeadSearchRowValidator),
  handler: async (ctx, args): Promise<PortalLeadSearchRow[]> => {
    const session = verifyPortalSessionToken(args.sessionToken);
    if (session.publicSlug !== args.portalSlug) {
      throw new Error("Portal session is no longer valid.");
    }

    // Anti-enumeration: refuse short queries before touching the database.
    const trimmed = args.searchTerm.trim();
    if (trimmed.length < 2) {
      return [];
    }

    // PII probe prevention on this shared-password surface: name/handle
    // search only — email/phone-shaped terms are rejected (also enforced in
    // the internal query).
    if (isPortalSearchTermPiiProbe(trimmed)) {
      return [];
    }

    const rows: PortalLeadSearchRow[] = await ctx.runQuery(
      internal.linkPortal.leadQueries.searchLeadsForSession,
      {
        tenantId: session.tenantId,
        publicSlug: args.portalSlug,
        sessionVersion: session.sessionVersion,
        searchTerm: trimmed,
      },
    );
    return rows;
  },
});

export const updatePortalLeadProfile = action({
  args: {
    portalSlug: v.string(),
    sessionToken: v.string(),
    dmCloserId: v.id("dmClosers"),
    leadId: v.id("leads"),
    // undefined leaves the field untouched; null clears it.
    initialSource: v.optional(v.union(leadInitialSourceValidator, v.null())),
    selfReportedIncome: v.optional(v.union(v.number(), v.null())),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const session = verifyPortalSessionToken(args.sessionToken);
    if (session.publicSlug !== args.portalSlug) {
      throw new Error("Portal session is no longer valid.");
    }

    await ctx.runMutation(
      internal.linkPortal.leadMutations.updateLeadProfileForSession,
      {
        tenantId: session.tenantId,
        publicSlug: args.portalSlug,
        sessionVersion: session.sessionVersion,
        sessionIdHash: hashSessionId(session.jti),
        dmCloserId: args.dmCloserId,
        leadId: args.leadId,
        ...(args.initialSource !== undefined
          ? { initialSource: args.initialSource }
          : {}),
        ...(args.selfReportedIncome !== undefined
          ? { selfReportedIncome: args.selfReportedIncome }
          : {}),
      },
    );
    return null;
  },
});

export const addPortalLeadNote = action({
  args: {
    portalSlug: v.string(),
    sessionToken: v.string(),
    dmCloserId: v.id("dmClosers"),
    leadId: v.id("leads"),
    content: v.string(),
  },
  returns: v.id("leadNotes"),
  handler: async (ctx, args): Promise<Id<"leadNotes">> => {
    const session = verifyPortalSessionToken(args.sessionToken);
    if (session.publicSlug !== args.portalSlug) {
      throw new Error("Portal session is no longer valid.");
    }

    const noteId: Id<"leadNotes"> = await ctx.runMutation(
      internal.linkPortal.leadMutations.insertLeadNoteForSession,
      {
        tenantId: session.tenantId,
        publicSlug: args.portalSlug,
        sessionVersion: session.sessionVersion,
        sessionIdHash: hashSessionId(session.jti),
        dmCloserId: args.dmCloserId,
        leadId: args.leadId,
        content: args.content,
      },
    );
    return noteId;
  },
});

export const listPortalLeadNotes = action({
  args: {
    portalSlug: v.string(),
    sessionToken: v.string(),
    leadId: v.id("leads"),
  },
  returns: v.array(portalLeadNoteRowValidator),
  handler: async (ctx, args): Promise<PortalLeadNoteRow[]> => {
    const session = verifyPortalSessionToken(args.sessionToken);
    if (session.publicSlug !== args.portalSlug) {
      throw new Error("Portal session is no longer valid.");
    }

    const notes: PortalLeadNoteRow[] = await ctx.runQuery(
      internal.linkPortal.leadQueries.listLeadNotesForSession,
      {
        tenantId: session.tenantId,
        publicSlug: args.portalSlug,
        sessionVersion: session.sessionVersion,
        leadId: args.leadId,
      },
    );
    return notes;
  },
});
