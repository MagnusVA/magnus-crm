import { v, type Infer } from "convex/values";
import type { Doc } from "../_generated/dataModel";

/**
 * The date a person asked to be contacted again ("not now, next month"),
 * saved by a lead generator or an admin (docs/plans/lead-gen-assistant.md,
 * "Release 2"). It lives on the person. Until the date arrives, no respark
 * claim picks the person and nobody can mark them resparked. It moves no
 * stage, disposition or touch.
 *
 * `at` is the start of that business day, resolved when the date was saved,
 * so a later change to the tenant's business day never moves it.
 */
export const contactAgainValidator = v.object({
  date: v.string(),
  at: v.number(),
  timeZone: v.string(),
  dayStartHour: v.number(),
  note: v.string(),
  setByUserId: v.id("users"),
  setAt: v.number(),
});

export type ContactAgain = Infer<typeof contactAgainValidator>;

export const CONTACT_AGAIN_NOTE_MAX = 500;

/** Why this person can't carry a contact-again date, or null. */
export function contactAgainForbidden(lead: Doc<"leads">): string | null {
  if (lead.status === "merged") return "This person was merged into another record.";
  if (lead.lifecycleStage === "customer" || lead.status === "converted") return "This person is a customer.";
  if (lead.disposition === "do_not_contact") return "This person is marked do not contact.";
  return null;
}

/** The date to show, or null: never shown for a person who can't carry one. */
export function visibleContactAgain(lead: Doc<"leads">): ContactAgain | null {
  return lead.contactAgain && !contactAgainForbidden(lead) ? lead.contactAgain : null;
}

/** True while the date is still ahead: the person waits out of the respark pool. */
export function contactAgainHolds(lead: Doc<"leads">, now: number): boolean {
  const saved = visibleContactAgain(lead);
  return saved !== null && saved.at > now;
}
