"use client";

import type { Id } from "@/convex/_generated/dataModel";
import { ReportProgramFilter } from "./report-program-filter";

export type ReportProgramDimension =
  | "booking_program"
  | "sold_program"
  | "payment_program";

const LABELS: Record<ReportProgramDimension, string> = {
  booking_program: "Booked program",
  sold_program: "Sold program",
  payment_program: "Payment program",
};

export function ReportProgramDimensionFilter({
  dimension,
  value,
  onChange,
  disabled,
}: {
  dimension: ReportProgramDimension;
  value?: Id<"tenantPrograms">;
  onChange: (value: Id<"tenantPrograms"> | undefined) => void;
  disabled?: boolean;
}) {
  return (
    <ReportProgramFilter
      value={value}
      onChange={onChange}
      disabled={disabled}
      label={LABELS[dimension]}
    />
  );
}
