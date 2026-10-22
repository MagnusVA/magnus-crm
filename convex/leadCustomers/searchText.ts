import type { Doc, Id } from "../_generated/dataModel";
import { dealSearchWords } from "../opportunities/stageLabels";

function pushValue(parts: string[], value: string | undefined) {
  const trimmed = value?.trim();
  if (trimmed) {
    parts.push(trimmed.toLowerCase());
  }
}

export function buildLeadCustomerSearchText(input: {
  lead: Doc<"leads">;
  identifiers: Array<Doc<"leadIdentifiers">>;
  opportunities: Array<
    Pick<
      Doc<"opportunities">,
      | "_id"
      | "manualCreationKey"
      | "source"
      | "stage"
      | "outcome"
      | "lostReason"
      | "lostByUserId"
      | "firstBookingProgramName"
      | "soldProgramName"
    >
  >;
  meetingIds: Array<Id<"meetings">>;
}) {
  const parts: string[] = [];
  pushValue(parts, input.lead._id);
  pushValue(parts, input.lead.fullName);
  pushValue(parts, input.lead.email);
  pushValue(parts, input.lead.phone);

  for (const handle of input.lead.socialHandles ?? []) {
    pushValue(parts, handle.type);
    pushValue(parts, handle.handle);
  }
  for (const identifier of input.identifiers) {
    pushValue(parts, identifier.value);
    pushValue(parts, identifier.rawValue);
  }
  for (const opportunity of input.opportunities) {
    pushValue(parts, opportunity._id);
    pushValue(parts, opportunity.manualCreationKey);
    // The deal's position, and a missed meeting's words on a deal one
    // closed (docs/plans/phase-5-deal-status.md §4.8).
    for (const word of dealSearchWords(opportunity)) {
      pushValue(parts, word);
    }
    pushValue(parts, opportunity.source);
    pushValue(parts, opportunity.firstBookingProgramName);
    pushValue(parts, opportunity.soldProgramName);
  }
  for (const meetingId of input.meetingIds) {
    pushValue(parts, meetingId);
  }

  return [...new Set(parts)].join(" ");
}
