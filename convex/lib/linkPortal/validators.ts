import { type Infer, v } from "convex/values";

export const portalPasswordHashParamsValidator = v.object({
  algorithm: v.literal("scrypt"),
  keyLength: v.number(),
  N: v.number(),
  r: v.number(),
  p: v.number(),
});

// === NIM-17 Phase 5: portal lead search / profile / notes ===

export const leadInitialSourceValidator = v.union(
  v.literal("cta"),
  v.literal("inbound"),
  v.literal("wechat"),
);

// Minimal PII-safe projection returned to the shared-password portal surface.
// Deliberately excludes email, phone, and customFields.
export const portalLeadSearchRowValidator = v.object({
  leadId: v.id("leads"),
  displayName: v.string(),
  socialHandles: v.array(
    v.object({
      type: v.string(),
      handle: v.string(),
    }),
  ),
  status: v.union(v.literal("active"), v.literal("converted")),
  initialSource: v.union(leadInitialSourceValidator, v.null()),
  selfReportedIncome: v.union(v.number(), v.null()),
  // Bounded count: capped at PORTAL_LEAD_NOTE_COUNT_CAP + 1 so the UI can
  // render "20+" without an unbounded collect.
  noteCount: v.number(),
  lastNoteAt: v.union(v.number(), v.null()),
});

export type PortalLeadSearchRow = Infer<typeof portalLeadSearchRowValidator>;

export const portalLeadNoteRowValidator = v.object({
  noteId: v.id("leadNotes"),
  content: v.string(),
  createdAt: v.number(),
  authorKind: v.union(v.literal("dm_closer"), v.literal("user")),
  authorLabel: v.string(),
});

export type PortalLeadNoteRow = Infer<typeof portalLeadNoteRowValidator>;

// Display cap for a lead's note count in portal search results.
export const PORTAL_LEAD_NOTE_COUNT_CAP = 20;

// Bounds enforced server-side on portal writes.
export const PORTAL_LEAD_NOTE_MAX_LENGTH = 2000;
export const PORTAL_LEAD_INCOME_MAX = 100_000_000;

// PII probe prevention on the shared-password portal surface: the
// search_leads index covers email and phone (leads.searchText embeds them),
// so a holder of the shared portal password could otherwise probe "does
// jane@x.com / +15551234567 exist as a lead". Portal search is name/handle
// only — reject terms that look like an email (contains "@") or a phone
// number (7+ digits after stripping non-digits). Shared by the public action
// and the internal query so the two guards cannot drift.
export function isPortalSearchTermPiiProbe(term: string): boolean {
  if (term.includes("@")) {
    return true;
  }
  const digits = term.replace(/\D/g, "");
  return digits.length >= 7;
}
