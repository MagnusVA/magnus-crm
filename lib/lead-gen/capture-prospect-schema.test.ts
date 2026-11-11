import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import { normalizeLeadGenProspectInput } from "../../convex/leadGen/normalization";
import {
  KEPT_INSTAGRAM_HANDLES,
  KEPT_INSTAGRAM_PROFILE_URLS,
  PLACEHOLDER_INSTAGRAM_HANDLES,
  REJECTED_INSTAGRAM_URLS,
} from "../../tests/instagramHandleCases";
import { captureProspectSchema } from "./capture-prospect-schema";
import {
  INVALID_INSTAGRAM_HANDLE_MESSAGE,
  normalizeInstagramHandle,
} from "./instagram-handle";

const keptPairs = [
  ...KEPT_INSTAGRAM_HANDLES,
  ...KEPT_INSTAGRAM_PROFILE_URLS.map((raw) => [raw, "real.handle"] as const),
];

const captureCases: ReadonlyArray<readonly [string, boolean]> = [
  ...keptPairs.map(([raw]) => [raw, true] as const),
  ...PLACEHOLDER_INSTAGRAM_HANDLES.map((raw) => [raw, false] as const),
  ...REJECTED_INSTAGRAM_URLS.map((raw) => [raw, false] as const),
  ["a.b", true],
  ["USER_Name", true],
  [" USER_Name ", true],
  ["https://www.instagram.com/some.user/?hl=en", true],
  ["https://instagram.com/USER/reels/", true],
  ["a".repeat(30), true],
  ["", false],
  ["   ", false],
  ["@", false],
  ["@a", false],
  ["__", false],
  ["https://tiktok.com/@x", false],
  ["user name", false],
  ["user/name", false],
  ["a".repeat(31), false],
  ["josé", false],
];

describe("captureProspectSchema", () => {
  it.each(captureCases)("the form and the server accept the same handles: %j", (input, accepted) => {
    const parsed = captureProspectSchema.safeParse({ rawHandleOrProfileUrl: input });
    let serverAccepted = false;
    try {
      normalizeLeadGenProspectInput({ source: "instagram", rawHandleOrProfileUrl: input });
      serverAccepted = true;
    } catch (error) {
      expect(error).toBeInstanceOf(ConvexError);
    }
    expect(parsed.success).toBe(serverAccepted);
    expect(parsed.success).toBe(accepted);
  });

  it.each([
    ["instagram.com/p/abc", INVALID_INSTAGRAM_HANDLE_MESSAGE],
    ["", "Paste a profile URL or handle first."],
    ["   ", "Paste a profile URL or handle first."],
  ])("a rejected handle carries the form's sentence: %j", (input, message) => {
    const parsed = captureProspectSchema.safeParse({ rawHandleOrProfileUrl: input });
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("Expected the form to reject the handle");
    expect(parsed.error.issues).toHaveLength(1);
    expect(parsed.error.issues[0].message).toBe(message);
  });

  it("the server rejects with a code and the same sentence", () => {
    let rejection: unknown;
    try {
      normalizeLeadGenProspectInput({
        source: "instagram",
        rawHandleOrProfileUrl: "instagram.com/p/abc",
      });
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(ConvexError);
    if (!(rejection instanceof ConvexError)) throw new Error("Expected a ConvexError");
    expect(rejection.data).toEqual({
      code: "lead_gen.invalid_instagram_handle",
      message: INVALID_INSTAGRAM_HANDLE_MESSAGE,
    });
  });

  it.each(keptPairs)("an accepted handle parses to what the server stores: %j", (raw, expected) => {
    const server = normalizeLeadGenProspectInput({
      source: "instagram",
      rawHandleOrProfileUrl: raw,
    });
    expect(normalizeInstagramHandle(raw)).toBe(server.normalizedHandle);
    expect(server.normalizedHandle).toBe(expected);
  });
});
