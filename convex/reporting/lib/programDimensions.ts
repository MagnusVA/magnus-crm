import { v } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";

export const reportProgramDimensionValidator = v.union(
  v.literal("booking_program"),
  v.literal("sold_program"),
  v.literal("payment_program"),
);

export type ReportProgramDimension =
  | "booking_program"
  | "sold_program"
  | "payment_program";

export function getProgramDimensionLabel(
  dimension: ReportProgramDimension,
): string {
  switch (dimension) {
    case "booking_program":
      return "Booked program";
    case "sold_program":
      return "Sold program";
    case "payment_program":
      return "Payment program";
  }
}

export function getBookingProgramId(
  row:
    | Pick<Doc<"meetings">, "bookingProgramId">
    | Pick<Doc<"opportunities">, "firstBookingProgramId">
    | null
    | undefined,
): Id<"tenantPrograms"> | undefined {
  if (!row) {
    return undefined;
  }
  if ("firstBookingProgramId" in row) {
    return (row as Pick<Doc<"opportunities">, "firstBookingProgramId">)
      .firstBookingProgramId;
  }
  return (row as Pick<Doc<"meetings">, "bookingProgramId">).bookingProgramId;
}

export function getSoldProgramId(
  row:
    | Pick<Doc<"customers">, "programId">
    | Pick<Doc<"paymentRecords">, "programId">
    | Pick<Doc<"opportunities">, "soldProgramId">
    | null
    | undefined,
): Id<"tenantPrograms"> | undefined {
  if (!row) {
    return undefined;
  }
  if ("soldProgramId" in row) {
    return (row as Pick<Doc<"opportunities">, "soldProgramId">).soldProgramId;
  }
  return (row as Pick<Doc<"customers">, "programId">).programId;
}
