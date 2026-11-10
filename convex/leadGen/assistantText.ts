import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { maskContactText } from "../lib/respark/people";

/**
 * Text a lead generator may read that staff wrote: a closer's no-show note,
 * a contact-again note (docs/plans/lead-gen-assistant.md, "Release 2"). A
 * lead gen never sees a payment, an unmasked contact detail, or a teammate's
 * or closer's name, and such a note can hold all three. So before one is
 * shown: contact details are masked, the tenant's staff names are replaced
 * with [staff], and amounts with [amount].
 *
 * It fails closed. If the roster is too large to read in full, no note is
 * shown at all, only that one exists. Names Magnus doesn't know (a nickname)
 * and money written as prose can't be caught; that limit is accepted.
 */
export const STAFF_ROSTER_LIMIT = 200;
export const SAFE_NOTE_MAX = 500;

export type SafeNote = { text: string; personSupplied: true; truncated: boolean };
export type SafeNoteResult =
  | { note: SafeNote; withheld: null }
  | { note: null; withheld: "staff_roster_too_large" };

export type StaffRedactor = {
  /** `people` are the leads whose own email and phone are masked too. */
  safeNote: (text: string, people?: Doc<"leads">[]) => SafeNoteResult;
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A symbol or code before the amount, or a code or currency word after it.
const AMOUNT = "\\d[\\d.,]*(?:\\s?[kKmM]\\b)?";
const CURRENCY_PATTERNS = [
  new RegExp(`(?:US\\$|\\$|€|£|¥|₡|₲)\\s?${AMOUNT}`, "g"),
  new RegExp(`\\b(?:USD|EUR|GBP|HNL|MXN|CAD)\\s?${AMOUNT}`, "gi"),
  // Lempira's "L 500": capital only, or every "l 5" in prose would match.
  new RegExp(`\\bL\\.?\\s?${AMOUNT}`, "g"),
  new RegExp(
    `${AMOUNT}\\s?(?:USD|EUR|GBP|HNL|MXN|CAD|usd|dollars?|dólares?|dolares?|euros?|pesos?|lempiras?|bucks|grand)\\b`,
    "gi",
  ),
  /\b\d+(?:[.,]\d+)?\s?k\b/gi,
];

/** Replaces amounts of money with [amount]. */
export function redactAmounts(text: string): string {
  return CURRENCY_PATTERNS.reduce((result, pattern) => result.replace(pattern, "[amount]"), text);
}

/** Full names first, then each name's parts of three letters or more. */
export function staffNamePattern(names: string[]): RegExp | null {
  const seen = new Set<string>();
  for (const name of names) {
    const whole = name.normalize("NFC").trim().replace(/\s+/g, " ");
    if (whole.length < 2) continue;
    seen.add(whole.toLowerCase());
    for (const part of whole.split(" ")) if (part.length >= 3) seen.add(part.toLowerCase());
  }
  if (seen.size === 0) return null;
  const alternatives = [...seen]
    .sort((a, b) => b.length - a.length)
    .map((name) => escapeRegExp(name).replace(/ /g, "\\s+"));
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}])`, "giu");
}

function trimmed(text: string): SafeNote {
  const truncated = text.length > SAFE_NOTE_MAX;
  return { text: truncated ? text.slice(0, SAFE_NOTE_MAX) : text, personSupplied: true, truncated };
}

/**
 * Reads the tenant's staff names once for a response: users, lead gen
 * workers and team members, inactive ones included. Pass the one redactor
 * to every note in that response.
 */
export async function loadStaffRedactor(ctx: QueryCtx, tenantId: Id<"tenants">): Promise<StaffRedactor> {
  const take = STAFF_ROSTER_LIMIT + 1;
  const [users, workers, members] = await Promise.all([
    ctx.db.query("users").withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId)).take(take),
    ctx.db
      .query("leadGenWorkers")
      .withIndex("by_tenantId_and_isActive", (q) => q.eq("tenantId", tenantId))
      .take(take),
    ctx.db.query("teamMembers").withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId)).take(take),
  ]);
  if (users.length > STAFF_ROSTER_LIMIT || workers.length > STAFF_ROSTER_LIMIT || members.length > STAFF_ROSTER_LIMIT) {
    return { safeNote: () => ({ note: null, withheld: "staff_roster_too_large" }) };
  }
  const names = [
    ...users.flatMap((user) => [user.fullName, user.calendlyMemberName]),
    ...workers.map((worker) => worker.displayName),
    ...members.map((member) => member.displayName),
  ].filter((name): name is string => typeof name === "string");
  const staff = staffNamePattern(names);
  return {
    safeNote: (text, people = []) => {
      let safe = maskContactText(text.normalize("NFC"), people);
      if (staff) safe = safe.replace(staff, "[staff]");
      return { note: trimmed(redactAmounts(safe).trim()), withheld: null };
    },
  };
}
