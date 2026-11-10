import type { LogEntry } from "@/convex/reports/log";
import type { ReportDocument } from "@/lib/operations-reports/document";

// The Log's shaping (docs/reviews/reports-overhaul.html §12): what each
// record type is called, where a record opens, and the loaded rows as an
// export document.

export type LogEntityType = LogEntry["entityType"];

export const ENTITY_TYPES: ReadonlyArray<{ value: LogEntityType; label: string; singular: string }> = [
  { value: "meeting", label: "Calls", singular: "Call" },
  { value: "opportunity", label: "Deals", singular: "Deal" },
  { value: "payment", label: "Payments", singular: "Payment" },
  { value: "lead", label: "People", singular: "Person" },
  { value: "followUp", label: "Reminders", singular: "Reminder" },
  { value: "enrollment", label: "Enrollments", singular: "Enrollment" },
  { value: "customer", label: "Customers", singular: "Customer" },
  { value: "user", label: "Team members", singular: "Team member" },
  { value: "slackInstallation", label: "Slack", singular: "Slack" },
];

export function entityWord(entityType: string) {
  return ENTITY_TYPES.find((type) => type.value === entityType)?.singular ?? entityType;
}

/** Where a record opens, when it has a page of its own. */
export function entityHref(entry: Pick<LogEntry, "entityType" | "entityId">): string | null {
  switch (entry.entityType) {
    case "meeting":
      return `/workspace/pipeline/meetings/${entry.entityId}`;
    case "opportunity":
      return `/workspace/opportunities/${entry.entityId}`;
    case "lead":
      return `/workspace/leads/${entry.entityId}`;
    case "customer":
      return `/workspace/customers/${entry.entityId}`;
    default:
      return null;
  }
}

/** The person the event is about, when the record isn't the person itself. */
export function personHref(entry: Pick<LogEntry, "entityType" | "leadId">): string | null {
  return entry.leadId && entry.entityType !== "lead" ? `/workspace/leads/${entry.leadId}` : null;
}

export function sentenceCase(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A stored status as words: "follow_up" → "Follow up". */
export function statusWords(status: string) {
  return sentenceCase(status.replaceAll("_", " "));
}

/** The loaded rows as a document: what the feed shows, newest first. */
export function buildLogDocument(
  entries: readonly LogEntry[],
  input: { words: string; dayLine: string; filters: string; generatedAt: number; complete: boolean },
): ReportDocument {
  return {
    title: "Log",
    period: input.words,
    generatedAt: input.generatedAt,
    boundary: input.dayLine,
    filters: input.filters,
    summary: [
      { label: input.complete ? "Events" : "Events loaded", value: entries.length.toLocaleString("en-US") },
    ],
    tables: [
      {
        title: input.complete ? "Events" : "Events loaded on the page",
        columns: [
          { key: "when", label: "When", format: "timestamp" },
          { key: "who", label: "Who" },
          { key: "what", label: "What" },
          { key: "record", label: "Record" },
          { key: "recordId", label: "Record ID" },
          { key: "status", label: "Status" },
        ],
        rows: entries.map((entry) => ({
          when: entry.occurredAt,
          who: entry.actorName ?? "System",
          what: sentenceCase(entry.label),
          record: entityWord(entry.entityType),
          recordId: entry.entityId,
          status: entry.toStatus ? statusWords(entry.toStatus) : null,
        })),
      },
    ],
  };
}
