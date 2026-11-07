"use client";

import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void) {
  window.addEventListener("focus", onChange);
  return () => window.removeEventListener("focus", onChange);
}
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const serverZone = () => undefined;

/** Hydrates from the browser, without rendering the server's zone as theirs. */
export function useBrowserTimezone() {
  return useSyncExternalStore(subscribe, browserZone, serverZone);
}
