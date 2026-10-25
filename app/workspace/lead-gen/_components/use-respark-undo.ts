"use client";

import { useEffect, useReducer, useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { getErrorMessage } from "@/lib/errors";
import { createUndoQueue } from "@/lib/respark/undoQueue";

export const NOT_A_FIT_UNDO_MS = 5000;

export const BATCH_ENDED_MESSAGE = "This batch ended with the business day.";

type ItemId = Id<"resparkBatchItems">;

function undoToastId(itemId: ItemId) {
  return `respark-undo-${itemId}`;
}

/**
 * Not a fit with a few seconds to undo (docs/plans/respark.md §4.5). The
 * mutation goes out when the window passes, when the caller flushes because
 * another card was acted on, or when the screen unmounts. A closed tab sends
 * nothing, and nothing goes out once the batch's hold has ended.
 */
export function useNotAFitUndo(heldUntil: number) {
  // Convex keeps a mutation's function stable for the client's lifetime.
  const markNotAFit = useMutation(api.respark.batches.markNotAFit);
  const [, rerender] = useReducer((count: number) => count + 1, 0);

  // The queue is created once. The screen remounts this hook per batch, and a
  // batch's hold end doesn't change, so its first value is the one to check.
  const [queue] = useState(() =>
    createUndoQueue<ItemId>({
      delayMs: NOT_A_FIT_UNDO_MS,
      send: (itemId) => {
        toast.dismiss(undoToastId(itemId));
        if (Date.now() >= heldUntil) return Promise.reject(new Error(BATCH_ENDED_MESSAGE));
        return markNotAFit({ itemId });
      },
      onError: (_itemId, error) => {
        toast.error(getErrorMessage(error, "Couldn't mark them not a fit."));
      },
      onChange: rerender,
    }),
  );

  // Leaving the screen inside the app sends what is pending (best effort).
  useEffect(() => () => queue.flush(), [queue]);

  const hold = (itemId: ItemId, handle: string) => {
    queue.hold(itemId);
    toast(`Marked ${handle} not a fit`, {
      id: undoToastId(itemId),
      description: "They stay in the CRM, last in the pool.",
      duration: NOT_A_FIT_UNDO_MS,
      action: { label: "Undo", onClick: () => queue.undo(itemId) },
    });
  };

  const undo = (itemId: ItemId) => {
    toast.dismiss(undoToastId(itemId));
    queue.undo(itemId);
  };

  return {
    hold,
    undo,
    flush: queue.flush,
    isPending: queue.isPending,
    isSending: queue.isSending,
    isSent: queue.isSent,
    dueAt: queue.dueAt,
  };
}
