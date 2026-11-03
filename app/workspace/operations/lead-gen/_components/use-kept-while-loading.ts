"use client";

import { useState } from "react";

/**
 * A section's data that stays on screen while new arguments load (DESIGN.md,
 * Kept Data While Reloading). `value` is undefined while loading; the last
 * loaded value is returned instead, with `reloading` set so the section dims.
 * `phrase` travels with the kept value, so its empty line still names the
 * range it was loaded for.
 */
export function useKeptWhileLoading<T>(value: T | undefined, phrase: string) {
  const [kept, setKept] = useState<{ value: T; phrase: string } | undefined>(
    value === undefined ? undefined : { value, phrase },
  );
  if (value !== undefined && (kept === undefined || kept.value !== value || kept.phrase !== phrase)) {
    setKept({ value, phrase });
  }
  return {
    data: value ?? kept?.value,
    phrase: value === undefined && kept ? kept.phrase : phrase,
    reloading: value === undefined && kept !== undefined,
  };
}
