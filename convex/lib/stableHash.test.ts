import { describe, expect, it } from "vitest";
import { sha256Hex, stableJson } from "./stableHash";

describe("stableJson", () => {
  it("sorts nested object keys and omits undefined fields", () => {
    const first = { z: { b: true, a: null }, a: [{ y: 2, x: 1 }], omit: undefined };
    const second = { a: [{ x: 1, y: 2 }], z: { a: null, b: true } };

    expect(stableJson(first)).toBe('{"a":[{"x":1,"y":2}],"z":{"a":null,"b":true}}');
    expect(stableJson(first)).toBe(stableJson(second));
  });

  it("preserves array order and encodes undefined entries as null", () => {
    expect(stableJson([2, undefined, 1])).toBe("[2,null,1]");
    expect(stableJson([1, 2])).not.toBe(stableJson([2, 1]));
  });
});

describe("sha256Hex", () => {
  it("returns a lowercase SHA-256 digest of the UTF-8 bytes", async () => {
    expect(await sha256Hex("caf\u00e9")).toBe(
      "850f7dc43910ff890f8879c0ed26fe697c93a067ad93a7d50f466a7028a9bf4e",
    );
  });
});
