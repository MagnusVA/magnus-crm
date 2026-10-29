"use client";

import { useEffect, useState } from "react";

/**
 * False until the browser is first idle after mount. For work a page will
 * almost certainly need but shouldn't do before its first paint, such as
 * mounting the dialogs behind its main action while they're still closed.
 */
export function useIdle(): boolean {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    const done = () => setIdle(true);
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(done, { timeout: 3000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(done, 1500);
    return () => window.clearTimeout(id);
  }, []);
  return idle;
}
