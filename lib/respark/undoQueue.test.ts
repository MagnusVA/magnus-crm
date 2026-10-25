import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUndoQueue } from "./undoQueue";

function setup(send: (id: string) => Promise<unknown> = () => Promise.resolve(null)) {
  const sendSpy = vi.fn(send);
  const onError = vi.fn();
  const onChange = vi.fn();
  const queue = createUndoQueue<string>({ delayMs: 5000, send: sendSpy, onError, onChange });
  return { queue, send: sendSpy, onError, onChange };
}

describe("createUndoQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends a held id once its delay passes", () => {
    const { queue, send } = setup();
    queue.hold("a");
    expect(queue.isPending("a")).toBe(true);
    vi.advanceTimersByTime(4999);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledExactlyOnceWith("a");
    expect(queue.isPending("a")).toBe(false);
  });

  it("reports when a held id is due", () => {
    vi.setSystemTime(1_000_000);
    const { queue } = setup();
    queue.hold("a");
    expect(queue.dueAt("a")).toBe(1_005_000);
    expect(queue.dueAt("b")).toBeNull();
  });

  it("undo cancels the send without calling the server", () => {
    const { queue, send } = setup();
    queue.hold("a");
    expect(queue.undo("a")).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(send).not.toHaveBeenCalled();
    expect(queue.undo("a")).toBe(false);
  });

  it("flush sends held ids at once, except the one acted on", () => {
    const { queue, send } = setup();
    queue.hold("a");
    queue.hold("b");
    queue.flush("b");
    expect(send).toHaveBeenCalledExactlyOnceWith("a");
    expect(queue.pendingIds()).toEqual(["b"]);
  });

  it("never sends the same id twice", () => {
    const { queue, send } = setup();
    queue.hold("a");
    queue.hold("a");
    queue.flush();
    queue.flush();
    vi.advanceTimersByTime(10_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("holding an id again restarts nothing", () => {
    const { queue, send } = setup();
    queue.hold("a");
    vi.advanceTimersByTime(3000);
    queue.hold("a");
    vi.advanceTimersByTime(2000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("an id can be held again after an undo", () => {
    const { queue, send } = setup();
    queue.hold("a");
    queue.undo("a");
    queue.hold("a");
    vi.advanceTimersByTime(5000);
    expect(send).toHaveBeenCalledExactlyOnceWith("a");
  });

  it("a rejected send reports the error and leaves nothing pending", async () => {
    const error = new Error("This batch ended with the business day.");
    const { queue, onError } = setup(() => Promise.reject(error));
    queue.hold("a");
    vi.advanceTimersByTime(5000);
    await vi.runAllTimersAsync();
    expect(onError).toHaveBeenCalledExactlyOnceWith("a", error);
    expect(queue.isPending("a")).toBe(false);
  });

  it("an id can't be held or sent again while its send is in flight", () => {
    const { queue, send } = setup(() => new Promise(() => {}));
    queue.hold("a");
    queue.flush();
    expect(queue.isSending("a")).toBe(true);
    queue.hold("a");
    queue.flush();
    vi.advanceTimersByTime(10_000);
    expect(queue.isPending("a")).toBe(false);
    expect(queue.undo("a")).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a rejected send frees the id so it can be acted on again", async () => {
    let reject: (error: unknown) => void = () => {};
    const { queue, send, onError } = setup(() => new Promise((_, r) => (reject = r)));
    queue.hold("a");
    queue.flush();
    const error = new Error("offline");
    reject(error);
    await vi.runAllTimersAsync();
    expect(onError).toHaveBeenCalledExactlyOnceWith("a", error);
    expect(queue.isSending("a")).toBe(false);
    expect(queue.isSent("a")).toBe(false);
    queue.hold("a");
    expect(queue.isPending("a")).toBe(true);
    queue.flush();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("a successful send leaves the id sent, and it can't be held again", async () => {
    const { queue, send, onError } = setup();
    queue.hold("a");
    queue.flush();
    await vi.runAllTimersAsync();
    expect(queue.isSending("a")).toBe(false);
    expect(queue.isSent("a")).toBe(true);
    queue.hold("a");
    expect(queue.isPending("a")).toBe(false);
    queue.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("a send that throws synchronously reports the error", () => {
    const error = new Error("offline");
    const { queue, onError } = setup(() => {
      throw error;
    });
    queue.hold("a");
    queue.flush();
    expect(onError).toHaveBeenCalledExactlyOnceWith("a", error);
  });

  it("calls onChange on hold, undo, send and the server's answer", async () => {
    const { queue, onChange } = setup();
    queue.hold("a");
    queue.undo("a");
    queue.hold("b");
    queue.flush();
    expect(onChange).toHaveBeenCalledTimes(4);
    await vi.runAllTimersAsync();
    expect(onChange).toHaveBeenCalledTimes(5);
  });
});
