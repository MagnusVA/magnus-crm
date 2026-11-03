import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  NOT_SALES_REASON_LABEL,
  type Destination,
  type IntelEventType,
  type IntelProgram,
} from "@/lib/booking-setup/event-type-intel";
import {
  eventTypeStatus,
  modeLabel,
  modeOf,
  type Board,
  type Coverage,
  type CoverageEventType,
  type EventTypeSorting,
} from "../booking-model";

export type BookingActivity = FunctionReturnType<typeof api.bookingSetup.queries.getBookingActivity>;

/** Optional extras from the full event type configs, keyed by id. */
export type EventTypeExtras = ReadonlyMap<string, { ownerName?: string; createdAt?: number; slug?: string }>;

/** Booking setup's rows in the shape the look-alike and suggestion logic reads. */
export function toIntelEventTypes(
  coverage: Coverage,
  board: Pick<Board, "placements">,
  activity: BookingActivity | undefined,
  extras?: EventTypeExtras,
): IntelEventType[] {
  return coverage.eventTypes.map((eventType) => toIntel(eventType, board, activity, extras));
}

function toIntel(
  eventType: CoverageEventType,
  board: Pick<Board, "placements">,
  activity: BookingActivity | undefined,
  extras?: EventTypeExtras,
): IntelEventType {
  return {
    id: eventType._id,
    name: eventType.displayName,
    calendlyName: eventType.calendlyName,
    durationMinutes: eventType.calendlyDurationMinutes,
    poolingType: eventType.calendlyPoolingType,
    kind: eventType.calendlyKind,
    formQuestionCount: eventType.formQuestionCount,
    status: eventTypeStatus(eventType),
    programId: eventType.bookingProgramId ?? undefined,
    mode: modeOf(eventType),
    bookings30d: activity?.bookings30d.eventTypes[eventType._id] ?? 0,
    inUse: (board.placements.get(eventType._id)?.length ?? 0) > 0,
    ownerName: extras?.get(eventType._id)?.ownerName,
    color: eventType.calendlyColor,
  };
}

export function toIntelPrograms(board: Pick<Board, "programs">): IntelProgram[] {
  return board.programs.map((program) => ({ id: program._id, name: program.name }));
}

/** What `sortEventType` takes for a destination. */
export function sortingFor(destination: Destination): EventTypeSorting {
  if (destination.kind === "program") {
    return { kind: "program", programId: destination.programId as Id<"tenantPrograms">, mode: destination.mode };
  }
  return { kind: "not_sales_call" };
}

/** "25K Accelerator · Priority", "Not a sales call · Personal calendar", "Duplicate of …". */
export function destinationLabel(
  destination: Destination,
  programName: (programId: string) => string,
  eventTypeName: (id: string) => string | undefined,
) {
  if (destination.kind === "program") return `${programName(destination.programId)} · ${modeLabel(destination.mode)}`;
  if (destination.reason === "duplicate") {
    const original = destination.duplicateOfId ? eventTypeName(destination.duplicateOfId) : undefined;
    return original ? `Duplicate of ${original}` : "Not a sales call · Duplicate";
  }
  return `Not a sales call · ${NOT_SALES_REASON_LABEL[destination.reason]}`;
}

/** The short button text for an alternative: "25K Accelerator · Standard", "Duplicate", "Personal calendar". */
export function alternativeLabel(destination: Destination, programName: (programId: string) => string) {
  if (destination.kind === "program") return `${programName(destination.programId)} · ${modeLabel(destination.mode)}`;
  return NOT_SALES_REASON_LABEL[destination.reason];
}

/** "calendly.com/d/dq7r-k2m-8vv/the-complete-strategy-meeting" */
export function shortUrl(url: string | undefined) {
  return url ? url.replace(/^https?:\/\//, "").replace(/\/$/, "") : null;
}
