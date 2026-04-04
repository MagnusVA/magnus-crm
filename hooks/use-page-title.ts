"use client";

import { useEffect } from "react";

const SUFFIX = " — Magnus CRM";

/**
 * Sets the document title for the current page.
 * Restores the default title on unmount.
 *
 * Usage: usePageTitle("Team") → "Team — Magnus CRM"
 */
export function usePageTitle(title: string) {
  useEffect(() => {
    const prev = document.title;
    document.title = `${title}${SUFFIX}`;
    return () => {
      document.title = prev;
    };
  }, [title]);
}
