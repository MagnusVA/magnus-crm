"use client";

import { useMutation } from "convex/react";
import type { OptimisticLocalStore } from "convex/browser";
import posthog from "posthog-js";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { getErrorMessage } from "@/lib/errors";
import { reportClientError } from "@/lib/observability/report-client-error";
import { withSorting, type EventTypeSorting } from "./booking-model";

export type SortRequest = {
  eventTypeConfigId: Id<"eventTypeConfigs">;
  sorting: EventTypeSorting;
};

type SortOptions = {
  /** The toast's words for how many were sorted ("Sorted into 25K Accelerator · Priority."). */
  message: (count: number) => string;
  /** Ids and enums only, for the PostHog event. */
  analytics: { source: "inbox" | "inbox_bulk" | "event_types"; to: EventTypeSorting["kind"]; suggested?: boolean };
};

// The coverage row as the mutation will leave it, so the inbox moves on at once.
function applyOptimistically(
  store: OptimisticLocalStore,
  args: { eventTypeConfigId: Id<"eventTypeConfigs">; sorting: EventTypeSorting },
) {
  const coverage = store.getQuery(api.bookingSetup.queries.getCoverage, {});
  if (!coverage) return;
  const now = Date.now();
  store.setQuery(api.bookingSetup.queries.getCoverage, {}, {
    ...coverage,
    eventTypes: coverage.eventTypes.map((eventType) =>
      eventType._id === args.eventTypeConfigId ? withSorting(eventType, args.sorting, now) : eventType,
    ),
  });
}

/**
 * Sorts one or more event types, then toasts with an Undo that puts each
 * back the way `sortEventType` says it was. The coverage subscription
 * updates optimistically, so the inbox moves on without waiting.
 * Resolves true when at least one was sorted.
 */
export function useSortEventTypes() {
  const sortEventType = useMutation(api.bookingSetup.mutations.sortEventType).withOptimisticUpdate(applyOptimistically);

  async function run(requests: readonly SortRequest[]) {
    const results = await Promise.allSettled(requests.map((request) => sortEventType(request)));
    const previous: SortRequest[] = [];
    let error: unknown = null;
    let failed = 0;
    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        previous.push({ eventTypeConfigId: requests[index].eventTypeConfigId, sorting: result.value });
      } else {
        failed += 1;
        error ??= result.reason;
      }
    });
    if (error !== null) {
      reportClientError(error, { flow: "booking_sort_event_type", failed, attempted: requests.length });
    }
    return { previous, failed, error };
  }

  async function undo(previous: readonly SortRequest[]) {
    const result = await run(previous);
    if (result.failed > 0) {
      toast.error(getErrorMessage(result.error, "Couldn't undo. Sort the event type again from Event types."));
      return;
    }
    posthog.capture("booking_event_type_sort_undone", { count: previous.length });
    toast(previous.length === 1 ? "Undone." : `Undone for ${previous.length} event types.`);
  }

  return async function sort(requests: readonly SortRequest[], options: SortOptions) {
    if (requests.length === 0) return false;
    const { previous, failed, error } = await run(requests);
    if (previous.length === 0) {
      toast.error(getErrorMessage(error, "Couldn't sort the event type. Try again."));
      return false;
    }
    posthog.capture("booking_event_type_sorted", { ...options.analytics, count: previous.length, failed });
    const message = options.message(previous.length);
    toast.success(failed > 0 ? `${message} ${failed} couldn't be sorted; try those again.` : message, {
      action: { label: "Undo", onClick: () => void undo(previous) },
    });
    return true;
  };
}
