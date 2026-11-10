"use client";

import { useEffect, useState } from "react";
import { businessDateForInstant, businessDayRange, type BusinessDaySetting } from "@/lib/businessDay";

/** A clock for dated subscriptions. The server still decides eligibility. */
export function useCurrentBusinessDate(setting: BusinessDaySetting) {
  const [now, setNow] = useState(() => Date.now());
  const currentBusinessDate = businessDateForInstant(now, setting);
  useEffect(() => {
    const actualNow = Date.now();
    const today = businessDateForInstant(actualNow, setting);
    // Also catches up when a tenant's settings change while mounted.
    const delay = today === currentBusinessDate ? businessDayRange(today, setting).end - actualNow : 0;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, delay));
    return () => clearTimeout(timer);
  }, [currentBusinessDate, setting, now]);
  return currentBusinessDate;
}
