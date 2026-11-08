import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import type { EnrollmentStatus } from "@/convex/enrollments/validators";
import { formatPhone } from "@/lib/phone";

// What the merge page says about two people, worked out the way `mergeLead`
// (convex/leads/merge.ts) merges them.

export type MergePreviewData = FunctionReturnType<typeof api.leads.queries.getMergePreview>;
type PersonFields = Pick<Doc<"leads">, "fullName" | "email" | "phone">;

/** The name, else the email, else the phone. */
export function personLabel(person: PersonFields): string {
  return person.fullName?.trim() || person.email?.trim() || (person.phone ? formatPhone(person.phone) : "") || "Unnamed person";
}

/** "Ana García" -> "Ana", for buttons; the label when there's no name. */
export function shortLabel(person: PersonFields): string {
  const name = person.fullName?.trim();
  return name ? name.split(/\s+/)[0] : personLabel(person);
}

/** The status word a person carries on this page. */
export function personWord(status: Doc<"leads">["status"]): { word: string; tone: "ok" | "muted" } {
  return status === "converted" ? { word: "Customer", tone: "ok" } : { word: "Lead", tone: "muted" };
}

export const ENROLLMENT_TONE: Record<EnrollmentStatus, "ok" | "warning" | "danger"> = {
  active: "ok",
  paused: "warning",
  churned: "danger",
};

/** merge.ts `isBlank`: missing, or only whitespace. */
function isBlank(value: string | undefined): value is undefined {
  return value === undefined || !value.trim();
}

/**
 * What happens to one profile field:
 * - same: both have it, and it's the same value;
 * - conflict: both have it and they differ, so the target's stays;
 * - fills: only the source has it, so it moves onto the target;
 * - kept: only the target has it;
 * - none: neither has it.
 */
export type FieldOutcome = "same" | "conflict" | "fills" | "kept" | "none";

const NORMALIZE = {
  fullName: (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase(),
  email: (value: string) => value.trim().toLowerCase(),
  phone: (value: string) => value.replace(/\D/g, ""),
} as const;

export function fieldOutcome(
  field: keyof typeof NORMALIZE,
  source: string | undefined,
  target: string | undefined,
): FieldOutcome {
  if (isBlank(target)) return isBlank(source) ? "none" : "fills";
  if (isBlank(source)) return "kept";
  return NORMALIZE[field](source) === NORMALIZE[field](target) ? "same" : "conflict";
}

/** Source identifiers the target lacks move; the ones it has are dropped (`type:value`, as merge.ts compares). */
export function splitIdentifiers(data: MergePreviewData) {
  const targetKeys = new Set(data.target.identifiers.map((identifier) => `${identifier.type}:${identifier.value}`));
  const moving: Doc<"leadIdentifiers">[] = [];
  const duplicates: Doc<"leadIdentifiers">[] = [];
  for (const identifier of data.source.identifiers) {
    (targetKeys.has(`${identifier.type}:${identifier.value}`) ? duplicates : moving).push(identifier);
  }
  return { moving, duplicates };
}

/** "ana@x.com, +1 (415) 555-2671": identifier values for a tooltip. */
export function identifierList(identifiers: Doc<"leadIdentifiers">[]) {
  return identifiers
    .map((identifier) => (identifier.type === "phone" ? formatPhone(identifier.value) : identifier.value))
    .join(", ");
}
