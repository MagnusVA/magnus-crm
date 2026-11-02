"use client";

import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import { businessDateForInstant } from "@/lib/businessDay";
import type { DashboardRangeValidationOptions } from "./dashboard-date-utils";
import { DateRangePicker, type DashboardRangeInput } from "./date-range-picker";
import { DayDefinition } from "./day-definition";

export type { DashboardRangeInput } from "./date-range-picker";

type Props = {
  browser?: boolean;
  bucketKind?: "meetings" | "lead-gen";
  value: DashboardRangeInput;
  onChange: (value: DashboardRangeInput) => void;
  validationMessage: string | null;
  validationOptions?: DashboardRangeValidationOptions;
};

/**
 * The Operations pages' range control on the page ground: the shared
 * `DateRangePicker`, the business-day line under it, and the range's
 * validation message. Overview sets the picker in its band instead.
 */
export function DashboardDateRangeFilter({
  browser = false,
  bucketKind,
  value,
  onChange,
  validationMessage,
  validationOptions,
}: Props) {
  const { setting } = useBusinessDay(bucketKind);
  const now = useNow();
  return (
    <div className="flex min-w-0 flex-col items-start gap-2 sm:items-end">
      <DateRangePicker
        value={value}
        onChange={onChange}
        validationOptions={validationOptions}
        todayBusinessDate={businessDateForInstant(now, setting)}
      />
      <DayDefinition browser={browser} bucketKind={bucketKind} />
      {validationMessage ? <p className="text-xs text-destructive">{validationMessage}</p> : null}
    </div>
  );
}
