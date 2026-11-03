import {
  lookalikeGroups,
  lookalikeIndex,
  modeWarning,
  type LookalikeGroup,
} from "@/lib/booking-setup/event-type-intel";
import {
  calendlyNameIfDifferent,
  cellIssue,
  eventTypeFacts,
  eventTypeStatus,
  linkIssue,
  usedInLabel,
  type Board,
  type Coverage,
  type CoverageEventType,
  type EventTypeStatus,
  type Placement,
} from "../booking-model";
import { toIntelEventTypes, type BookingActivity } from "./intel-adapter";

export type Tone = "ok" | "slate" | "danger" | "warn" | "blue" | "plain";

export type EventTypeRow = {
  eventType: CoverageEventType;
  status: EventTypeStatus;
  programName: string | null;
  bookings: number;
  /** The line under the name: a warning, Calendly's name, the look-alike family, or the facts. */
  sub: { text: string; warn: boolean };
  warning: string | null;
  bookable: { word: string; tone: Tone };
  portal: { word: string; tone: Tone; title?: string; condensed: boolean };
  placements: readonly Placement[];
  brokenPlacements: number;
  group: LookalikeGroup | undefined;
  /** Search text, normalised. */
  haystack: string;
};

export type EventTypeFilter = "sales" | "unsorted" | "looks" | "not_sales_call" | "gone" | "all";

export const EVENT_TYPE_FILTERS: readonly EventTypeFilter[] = ["sales", "unsorted", "looks", "not_sales_call", "gone", "all"];

export function parseFilter(value: string | null): EventTypeFilter {
  if (value === "sorted") return "sales";
  return EVENT_TYPE_FILTERS.includes(value as EventTypeFilter) ? (value as EventTypeFilter) : "sales";
}

export function bookableWord(eventType: CoverageEventType, status: EventTypeStatus): { word: string; tone: Tone } {
  if (status === "not_sales_call") return { word: "—", tone: "slate" };
  if (eventType.calendlySyncStatus === "inactive") return { word: "Inactive", tone: "warn" };
  if (eventType.calendlySyncStatus === "deleted") return { word: "Deleted", tone: "warn" };
  if (eventType.calendlySyncStatus === "not_returned") return { word: "Not returned", tone: "warn" };
  if (linkIssue(eventType) === "missing_url") return { word: "No URL", tone: "danger" };
  return status === "sorted" ? { word: "Ready", tone: "ok" } : { word: "Bookable", tone: "slate" };
}

/** Every event type as a row of the Event types table, with its look-alike groups. */
export function buildEventTypeRows(coverage: Coverage, board: Board, activity: BookingActivity | undefined) {
  const intel = toIntelEventTypes(coverage, board, activity);
  const groups = lookalikeGroups(intel);
  const groupOf = lookalikeIndex(groups);
  const programName = (id: string | undefined) =>
    id ? (coverage.programs.find((program) => program._id === id)?.name ?? "A removed program") : null;

  const rows = coverage.eventTypes.map<EventTypeRow>((eventType, index) => {
    const status = eventTypeStatus(eventType);
    const placements = board.placements.get(eventType._id) ?? [];
    const brokenPlacements = placements.filter(
      (placement) => cellIssue({ programId: placement.programId, mode: placement.mode, eventTypeConfigId: eventType._id }, eventType) !== null,
    ).length;
    const group = groupOf.get(eventType._id);
    const warning = modeWarning(intel[index]);
    const renamed = calendlyNameIfDifferent(eventType);
    const sub = warning
      ? { text: warning, warn: true }
      : renamed
        ? { text: `Calendly: ${renamed}`, warn: false }
        : group
          ? { text: lookalikeLine(eventType, group), warn: false }
          : { text: eventTypeFacts(eventType), warn: false };

    let portal: EventTypeRow["portal"];
    const used = usedInLabel(placements);
    if (brokenPlacements > 0) portal = { word: `Broken in ${brokenPlacements}`, tone: "danger", condensed: true };
    else if (used) portal = { word: used, tone: "plain", condensed: false };
    else if (status === "sorted" && linkIssue(eventType) === null) portal = { word: "Ready to place", tone: "blue", condensed: true };
    else portal = { word: "—", tone: "slate", condensed: false };

    const name = programName(eventType.bookingProgramId);
    return {
      eventType,
      status,
      programName: status === "sorted" ? name : null,
      bookings: intel[index].bookings30d,
      sub,
      warning,
      bookable: bookableWord(eventType, status),
      portal,
      placements,
      brokenPlacements,
      group,
      haystack: `${eventType.displayName} ${eventType.calendlyName ?? ""} ${name ?? ""}`.toLowerCase(),
    };
  });

  rows.sort(
    (left, right) =>
      right.bookings - left.bookings ||
      left.eventType.displayName.localeCompare(right.eventType.displayName, "en", { sensitivity: "base", numeric: true }),
  );

  const counts = {
    sales: rows.filter((row) => row.status === "sorted").length,
    unsorted: rows.filter((row) => row.status === "unsorted").length,
    looks: groups.length,
    fold: groups.reduce((sum, group) => sum + group.foldable.length, 0),
    not_sales_call: rows.filter((row) => row.status === "not_sales_call").length,
    gone: rows.filter((row) => row.status === "gone").length,
    all: rows.length,
  };

  return { rows, groups, counts, intel };
}

export function rowMatchesFilter(row: EventTypeRow, filter: EventTypeFilter) {
  switch (filter) {
    case "sales":
      return row.status === "sorted";
    case "unsorted":
      return row.status === "unsorted";
    case "not_sales_call":
      return row.status === "not_sales_call";
    case "gone":
      return row.status === "gone";
    default:
      return true;
  }
}

/** Coverage's own link to a cell: `/workspace/booking?cell=shared.<programId>.priority`. */
export function coverageCellHref(placement: Placement) {
  return `/workspace/booking?cell=${placement.teamId ?? "shared"}.${placement.programId}.${placement.mode === "extended" ? "standard" : "priority"}`;
}

// "Look-alike of Complete Strategy Meeting"; when the family carries this
// event type's own name, name another member instead.
function lookalikeLine(eventType: CoverageEventType, group: LookalikeGroup) {
  if (group.label.toLowerCase() !== eventType.displayName.trim().toLowerCase()) {
    return `Look-alike of ${group.label}`;
  }
  const others = group.members.filter((member) => member.eventType.id !== eventType._id);
  return `Look-alike of ${others[0]?.eventType.name ?? group.label}${others.length > 1 ? ` and ${others.length - 1} more` : ""}`;
}
