import type { convexTest } from "convex-test";
import type { Id } from "../convex/_generated/dataModel";

type TestConvex = ReturnType<typeof convexTest>;

let filesStored = 0;

/**
 * Stores a proof file the way the payment dialogs upload one. convex-test
 * records a file's size and sha256 but not its content type, which the
 * upload URL takes from the request's `Content-Type`, so this sets it on the
 * `_storage` row. `size` overrides the recorded size, to stand for a large
 * file without allocating one.
 */
export async function storeProofFile(
  t: TestConvex,
  options: { contents?: string; contentType?: string | null; size?: number } = {},
): Promise<Id<"_storage">> {
  // Distinct and repeatable, so each file has its own hash in every run.
  const contents = options.contents ?? `receipt ${++filesStored}`;
  const contentType = options.contentType === undefined ? "image/png" : options.contentType;
  return await t.run(async (ctx) => {
    const fileId = await ctx.storage.store(new Blob([contents]));
    const fields: Record<string, unknown> = {};
    if (contentType !== null) fields.contentType = contentType;
    if (options.size !== undefined) fields.size = options.size;
    if (Object.keys(fields).length > 0) {
      // System tables are read-only through ctx.db, so this goes to the
      // syscall convex-test serves for db.patch.
      const convex = (globalThis as unknown as {
        Convex: { asyncSyscall: (op: string, args: string) => Promise<string> };
      }).Convex;
      await convex.asyncSyscall("1.0/shallowMerge", JSON.stringify({ table: "_storage", id: fileId, value: fields }));
    }
    return fileId;
  });
}
