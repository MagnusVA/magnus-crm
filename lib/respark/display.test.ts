import { describe, expect, it } from "vitest";
import {
  formatBatchDuration,
  instagramProfileUrl,
  isTypingTarget,
  resparkBucketLabel,
  summarizeBatch,
} from "./display";

describe("summarizeBatch", () => {
  it("counts each result and times the claim to the last action", () => {
    const summary = summarizeBatch({
      createdAt: 1_000,
      items: [
        { result: "resparked", workedAt: 61_000 },
        { result: "not_a_fit", workedAt: 7_801_000 },
        { result: "skipped", workedAt: 30_000 },
        { result: null, workedAt: null },
      ],
    });
    expect(summary).toEqual({
      worked: 3, total: 4, entries: 1, notAFit: 1, skipped: 1, durationMs: 7_800_000,
    });
  });

  it("has no duration before any action", () => {
    expect(summarizeBatch({ createdAt: 0, items: [{ result: null, workedAt: null }] }).durationMs).toBeNull();
  });
});

describe("formatBatchDuration", () => {
  it("reads as hours and minutes", () => {
    expect(formatBatchDuration(30_000)).toBe("under a minute");
    expect(formatBatchDuration(45 * 60_000)).toBe("45 min");
    expect(formatBatchDuration(120 * 60_000)).toBe("2 h");
    expect(formatBatchDuration(130 * 60_000 + 59_000)).toBe("2 h 10 min");
  });
});

describe("instagramProfileUrl", () => {
  it("builds the profile URL from a handle with or without @", () => {
    expect(instagramProfileUrl("@sample.coach")).toBe("https://instagram.com/sample.coach");
    expect(instagramProfileUrl("sample_one")).toBe("https://instagram.com/sample_one");
    expect(instagramProfileUrl(" ")).toBeNull();
    expect(instagramProfileUrl(null)).toBeNull();
  });
});

describe("resparkBucketLabel", () => {
  it("uses the proposal's labels", () => {
    expect(resparkBucketLabel(1)).toBe("Qualified, never booked");
    expect(resparkBucketLabel(4)).toBe("Had a call, deal lost");
  });
});

describe("isTypingTarget", () => {
  it("is true for inputs and editable content only", () => {
    expect(isTypingTarget({ tagName: "INPUT" } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: "TEXTAREA" } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: "ARTICLE", isContentEditable: false } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
