import type { Doc, Id } from "../_generated/dataModel";

function pushValue(parts: string[], value: string | undefined) {
  const trimmed = value?.trim();
  if (trimmed) {
    parts.push(trimmed.toLowerCase());
  }
}

export function buildLeadCustomerSearchText(input: {
  lead: Doc<"leads">;
  customer: Doc<"customers"> | null;
  identifiers: Array<Doc<"leadIdentifiers">>;
  opportunities: Array<
    Pick<
      Doc<"opportunities">,
      | "_id"
      | "manualCreationKey"
      | "status"
      | "source"
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
  pushValue(parts, input.customer?._id);
  pushValue(parts, input.customer?.fullName);
  pushValue(parts, input.customer?.email);
  pushValue(parts, input.customer?.phone);

  for (const handle of input.lead.socialHandles ?? []) {
    pushValue(parts, handle.type);
    pushValue(parts, handle.handle);
  }
  for (const handle of input.customer?.socialHandles ?? []) {
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
    pushValue(parts, opportunity.status);
    pushValue(parts, opportunity.source);
    pushValue(parts, opportunity.firstBookingProgramName);
    pushValue(parts, opportunity.soldProgramName);
  }
  for (const meetingId of input.meetingIds) {
    pushValue(parts, meetingId);
  }

  return [...new Set(parts)].join(" ");
}
