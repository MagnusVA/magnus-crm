import { afterEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import {
  enrollmentHarness,
  insertDeal,
  insertPayment,
  insertPerson,
  insertProgram,
  type EnrollmentHarness,
} from "../../tests/enrollmentFixtures";
import { storeProofFile } from "../../tests/proofFixtures";

// Decision 15 (docs/plans/closer-assistant.md §6.3): the backfill hashes the
// proof of payments written before the AI assistant, and flags reuse.

afterEach(() => vi.useRealTimers());

async function seed(harness: EnrollmentHarness) {
  const shared = "the same receipt";
  const files = {
    first: await storeProofFile(harness.t, { contents: shared }),
    second: await storeProofFile(harness.t, { contents: shared }),
    own: await storeProofFile(harness.t, { contents: "another receipt" }),
    gone: await storeProofFile(harness.t, { contents: "a deleted receipt" }),
  };
  return await harness.t.run(async (ctx) => {
    const programId = await insertProgram(ctx, harness.tenantId, "Program");
    const leadId = await insertPerson(ctx, harness.tenantId);
    const opportunityId = await insertDeal(ctx, harness.tenantId, leadId);
    const pay = async (proofFileId?: Id<"_storage">) => {
      const id = await insertPayment(ctx, { tenantId: harness.tenantId, opportunityId, programId, recordedAt: 0 });
      if (proofFileId) await ctx.db.patch("paymentRecords", id, { proofFileId });
      return id;
    };
    const ids = {
      first: await pay(files.first),
      noProof: await pay(),
      own: await pay(files.own),
      gone: await pay(files.gone),
      second: await pay(files.second),
    };
    await ctx.storage.delete(files.gone);
    // A payment written after the deploy, with its hash, whose file an
    // older payment also holds.
    const sha = (await ctx.db.system.get("_storage", files.first))!.sha256;
    const live = await pay(await ctx.storage.store(new Blob([shared])));
    await ctx.db.patch("paymentRecords", live, { proofSha256: sha, recordedVia: "web" });
    return { ...ids, live, sha };
  });
}

async function payments(harness: EnrollmentHarness) {
  return await harness.t.run(async (ctx) =>
    Object.fromEntries(
      (await ctx.db.query("paymentRecords").take(20)).map((payment) => [
        payment._id,
        { proofSha256: payment.proofSha256, proofReused: payment.proofReused },
      ]),
    ),
  );
}

describe("backfillPaymentProofHashes", () => {
  it("hashes each proof, flags the later payments that share one, and passes its assert", async () => {
    const harness = await enrollmentHarness();
    const ids = await seed(harness);
    expect((await harness.run("assertPaymentProofHashes"))?.error).toContain(ids.first);

    expect((await harness.run("backfillPaymentProofHashes"))?.error).toBeUndefined();

    const rows = await payments(harness);
    expect(rows[ids.first]).toEqual({ proofSha256: ids.sha, proofReused: undefined });
    expect(rows[ids.second]).toEqual({ proofSha256: ids.sha, proofReused: true });
    expect(rows[ids.live]).toEqual({ proofSha256: ids.sha, proofReused: true });
    expect(rows[ids.own].proofSha256).toEqual(expect.any(String));
    expect(rows[ids.own].proofReused).toBeUndefined();
    expect(rows[ids.noProof]).toEqual({ proofSha256: undefined, proofReused: undefined });
    expect(rows[ids.gone]).toEqual({ proofSha256: undefined, proofReused: undefined });
    expect((await harness.run("assertPaymentProofHashes"))?.error).toBeUndefined();

    // A second run changes nothing.
    expect((await harness.rerun("backfillPaymentProofHashes"))?.error).toBeUndefined();
    expect(await payments(harness)).toEqual(rows);
  });

  it("the assert names a payment flagged reused with no earlier match", async () => {
    const harness = await enrollmentHarness();
    const ids = await seed(harness);
    await harness.run("backfillPaymentProofHashes");
    await harness.t.run((ctx) => ctx.db.patch("paymentRecords", ids.own, { proofReused: true }));
    expect((await harness.rerun("assertPaymentProofHashes"))?.error).toContain(ids.own);
  });
});
