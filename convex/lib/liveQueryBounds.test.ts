import { describe, expect, it } from "vitest";
import { readLiveDocuments, readLiveQueryRows } from "./liveQueryBounds";

async function* rows<T>(values: T[]) {
  for (const value of values) yield value;
}

describe("live query byte bounds", () => {
  it("uses one sentinel row to distinguish an exact row limit from overflow", async () => {
    await expect(readLiveQueryRows(rows([{ n: 1 }, { n: 2 }]), 2)).resolves.toEqual({
      rows: [{ n: 1 }, { n: 2 }],
      capped: false,
    });
    await expect(
      readLiveQueryRows(rows([{ n: 1 }, { n: 2 }, { n: 3 }]), 2),
    ).resolves.toEqual({ rows: [{ n: 1 }, { n: 2 }], capped: true });
  });

  it("stops point-read hydration before retained documents exceed 512 KiB", async () => {
    const document = { payload: "x".repeat(300 * 1024) };
    const result = await readLiveDocuments([1, 2], async () => document);
    expect(result.rows).toHaveLength(1);
    expect(result.capped).toBe(true);
  });
});
