"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { BAND_SELECT } from "../../_components/report-ui";

/**
 * The band's currency select (the Sales calls one), shown only when the range
 * has more than one currency. Money is never added across currencies, so the
 * page shows one at a time (reports-decisions D8).
 */
export function CurrencySelect({
  currencies,
  value,
  onChange,
}: {
  currencies: readonly string[];
  value: string;
  onChange: (next: string) => void;
}) {
  if (currencies.length < 2) return null;
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        aria-label="Currency"
        className={cn(BAND_SELECT, "w-auto font-condensed text-[14px] font-semibold tracking-[0.02em]")}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {currencies.map((option) => (
          <SelectItem key={option} value={option}>
            {option}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

