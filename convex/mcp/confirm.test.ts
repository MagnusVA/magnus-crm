import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpHarness, seedTenantWithCloser } from "../../tests/mcpHarness";
import { issueConfirmation, markConfirmationUsed, redeemConfirmation } from "./confirm";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("redeemConfirmation", () => {
  it("checks the tenant, the tool and the details before it replays a used token", async () => {
    const { t } = await createMcpHarness();
    const a = await seedTenantWithCloser(t);
    const b = await seedTenantWithCloser(t, { orgId: "org_other", workosUserId: "other|user_alex" });
    const who = { tenantId: a.tenantId, userId: a.closerId };
    const args = { amount: 100 };

    const token = await t.run(async (ctx) => {
      const issued = await issueConfirmation(ctx, who, "tool_a", args, "preview");
      const redeemed = await redeemConfirmation(ctx, who, "tool_a", issued.confirmToken, args);
      if (redeemed.kind !== "fresh") throw new Error("expected a fresh token");
      await markConfirmationUsed(ctx, redeemed.confirmationId, { saved: true });
      return issued.confirmToken;
    });

    const redeem = (as: typeof who, tool: string, withArgs: unknown) =>
      t.run((ctx) => redeemConfirmation(ctx, as, tool, token, withArgs));

    await expect(redeem(who, "tool_a", args)).resolves.toEqual({ kind: "replay", result: { saved: true } });
    await expect(redeem(who, "tool_a", { amount: 999 })).rejects.toThrow("differ from the preview");
    await expect(redeem(who, "tool_b", args)).rejects.toThrow("isn't valid");
    await expect(redeem({ tenantId: b.tenantId, userId: a.closerId }, "tool_a", args)).rejects.toThrow("isn't valid");
    await expect(redeem({ tenantId: a.tenantId, userId: a.ownerId }, "tool_a", args)).rejects.toThrow("isn't valid");
  });
});
