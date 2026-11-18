import { expect, it } from "vitest";
import { assertPaymentInvariants } from "../../tests/paymentInvariants";
import { FIXTURE_NOW, paymentConfirmationApi, paymentConfirmationFixture } from "../../tests/providerPaymentFixtures";
import { addPinnedLine } from "../lib/pinnedLines";

const { listMyPinnedLines, dismissPinnedLine } = paymentConfirmationApi.closer.pinnedLines;

it("lists the closer's newest 20 lines and dismisses only their own line", async () => {
  const f = await paymentConfirmationFixture();
  const { own, other } = await f.t.run(async (ctx) => {
    const otherId = await ctx.db.insert("users", {
      tenantId: f.tenantId, workosUserId: "user_other", email: "other@example.com", role: "closer", isActive: true,
    });
    const line = { tenantId: f.tenantId, opportunityId: f.dealId, kind: "win_removed" as const };
    const own = [];
    for (let i = 0; i < 21; i++) {
      own.push(await addPinnedLine(ctx, { ...line, userId: f.closerId, createdAt: FIXTURE_NOW + i }));
    }
    const other = await addPinnedLine(ctx, { ...line, userId: otherId, createdAt: FIXTURE_NOW + 100 });
    return { own, other };
  });
  const otherClient = f.t.withIdentity({ subject: "user_other", org_id: "org_test" });
  const invariant = () => assertPaymentInvariants(f.t, { tenantId: f.tenantId });
  await invariant();
  const lines = await f.closer.query(listMyPinnedLines, {});
  expect(lines.map((line) => line._id)).toEqual(own.slice(1).reverse());
  expect(lines[0]).toMatchObject({ leadId: f.personId, personName: "River Patel" });
  expect((await otherClient.query(listMyPinnedLines, {})).map((line) => line._id)).toEqual([other]);
  expect(await f.closer.mutation(dismissPinnedLine, { lineId: other })).toEqual({ ok: false, code: "not_owner" });
  await invariant();
  const args = { lineId: own[20] };
  expect(await f.closer.mutation(dismissPinnedLine, args)).toEqual({ ok: true, alreadyApplied: false });
  await invariant();
  expect(await f.closer.mutation(dismissPinnedLine, args)).toEqual({ ok: true, alreadyApplied: true });
  await invariant();
  expect((await f.closer.query(listMyPinnedLines, {})).map((line) => line._id)).toEqual(own.slice(0, 20).reverse());
  await expect(f.admin.query(listMyPinnedLines, {})).rejects.toThrow();
});
