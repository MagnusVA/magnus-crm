"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * False on the server and while the page hydrates, true after. Text in the
 * browser's own time zone renders only once this is true: the server renders
 * in UTC, so its HTML would show a wrong time and fail to hydrate. Client-side
 * navigations get true on their first render.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
