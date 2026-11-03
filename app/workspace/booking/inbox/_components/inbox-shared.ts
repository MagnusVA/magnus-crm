import type { CoverageEventType, CoverageProgram, SchedulingMode } from "../../_components/booking-model";

export type Suggestion = { programId: CoverageProgram["_id"]; mode: SchedulingMode; reason: string };

export type InboxItem = {
  eventType: CoverageEventType;
  suggestion: Suggestion | null;
};

/** Unsorted event types that share a suggestion, for "Accept all". */
export type SuggestionGroup = {
  key: string;
  programId: CoverageProgram["_id"];
  mode: SchedulingMode;
  items: InboxItem[];
};
