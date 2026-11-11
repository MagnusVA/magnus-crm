"use client";

import { useEffect, useSyncExternalStore } from "react";

import { CardFooter } from "@/app/onboarding/_components/onboarding-ui";
import { Button } from "@/components/ui/button";
import {
  RETRY_DELAYS_SECONDS,
  attemptsFromStored,
  storedAttempts,
} from "@/lib/unavailable-retries";

const STORAGE_KEY = "magnus:unavailable-retries";

/**
 * Tries made so far. Null until the browser has read it: while the page
 * hydrates, or when session storage is blocked. With no count to stop at,
 * the page never retries on its own.
 */
function readAttempts(): number | null {
  try {
    return attemptsFromStored(window.sessionStorage.getItem(STORAGE_KEY), Date.now());
  } catch {
    return null;
  }
}

/** A full page load, so the server gate runs again. The gate sends a failed try back here. */
function tryWorkspace(attemptsMade: number) {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, storedAttempts(attemptsMade, Date.now()));
  } catch {
    // The count is lost, so the next visit shows the button only.
  }
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a router transition would keep this page mounted and never retry again
  window.location.assign("/workspace");
}

const noSubscription = () => () => {};

function waitWords(seconds: number) {
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = seconds / 60;
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/**
 * Goes back to the workspace after 10 seconds, then 30, 60, 120 and 300, and
 * after that only when asked. The count of tries lives in session storage,
 * because each try is a page load that lands back here when it fails.
 */
export function UnavailableRetry() {
  const attempts = useSyncExternalStore(noSubscription, readAttempts, () => null);
  const delay = attempts === null ? undefined : RETRY_DELAYS_SECONDS[attempts];

  useEffect(() => {
    if (attempts === null || delay === undefined) return;
    const timer = window.setTimeout(() => tryWorkspace(attempts + 1), delay * 1000);
    return () => window.clearTimeout(timer);
  }, [attempts, delay]);

  return (
    <CardFooter
      aside={
        attempts === null
          ? undefined
          : delay === undefined
            ? "This page has stopped trying on its own."
            : `Trying again in ${waitWords(delay)}.`
      }
    >
      <Button
        className="font-semibold"
        onClick={() => tryWorkspace(Math.min((attempts ?? 0) + 1, RETRY_DELAYS_SECONDS.length))}
      >
        Try now
      </Button>
    </CardFooter>
  );
}
