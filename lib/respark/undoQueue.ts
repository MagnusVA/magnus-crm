// The browser-side undo for Not a fit (docs/plans/respark.md §4.5). A held
// send waits `delayMs`, then goes to the server. Acting on another card sends
// it at once, Undo cancels it without a server call, and each send happens at
// most once. An id stays sending until the server answers, so its card can't
// be acted on twice; a rejected send frees it again. A closed tab sends
// nothing: the person stays held and unworked.

export type UndoQueueOptions<Id extends string> = {
  delayMs: number;
  send: (id: Id) => Promise<unknown>;
  /** A rejected send. The id is no longer pending or sending, so its card shows again. */
  onError: (id: Id, error: unknown) => void;
  /** Called whenever an id becomes pending, sending or sent, or is freed again. */
  onChange?: () => void;
};

export type UndoQueue<Id extends string> = {
  /** Holds a send for `id`. Holding an id that is pending, sending or sent changes nothing. */
  hold: (id: Id) => void;
  /** Cancels a held send. Returns whether one was pending. */
  undo: (id: Id) => boolean;
  /** Sends every held send now, except the one for `exceptId`. */
  flush: (exceptId?: Id) => void;
  isPending: (id: Id) => boolean;
  /** The send for `id` went out and the server hasn't answered yet. */
  isSending: (id: Id) => boolean;
  /** The server accepted the send for `id`. */
  isSent: (id: Id) => boolean;
  pendingIds: () => Id[];
  /** When the held send for `id` goes out on its own, or null. */
  dueAt: (id: Id) => number | null;
};

export function createUndoQueue<Id extends string>(
  options: UndoQueueOptions<Id>,
): UndoQueue<Id> {
  const pending = new Map<Id, { timer: ReturnType<typeof setTimeout>; dueAt: number }>();
  const sending = new Set<Id>();
  const sent = new Set<Id>();

  const fail = (id: Id, error: unknown) => {
    sending.delete(id);
    options.onChange?.();
    options.onError(id, error);
  };

  const send = (id: Id) => {
    const entry = pending.get(id);
    if (!entry) return;
    // Removed before the call, so a timer and a flush can't both send it.
    clearTimeout(entry.timer);
    pending.delete(id);
    sending.add(id);
    options.onChange?.();
    let result: Promise<unknown>;
    try {
      result = options.send(id);
    } catch (error) {
      fail(id, error);
      return;
    }
    result.then(
      () => {
        sending.delete(id);
        sent.add(id);
        options.onChange?.();
      },
      (error: unknown) => fail(id, error),
    );
  };

  return {
    hold(id) {
      if (pending.has(id) || sending.has(id) || sent.has(id)) return;
      const dueAt = Date.now() + options.delayMs;
      pending.set(id, { timer: setTimeout(() => send(id), options.delayMs), dueAt });
      options.onChange?.();
    },
    undo(id) {
      const entry = pending.get(id);
      if (!entry) return false;
      clearTimeout(entry.timer);
      pending.delete(id);
      options.onChange?.();
      return true;
    },
    flush(exceptId) {
      for (const id of [...pending.keys()]) {
        if (id !== exceptId) send(id);
      }
    },
    isPending: (id) => pending.has(id),
    isSending: (id) => sending.has(id),
    isSent: (id) => sent.has(id),
    pendingIds: () => [...pending.keys()],
    dueAt: (id) => pending.get(id)?.dueAt ?? null,
  };
}
