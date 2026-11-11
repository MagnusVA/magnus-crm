import { ConvexError } from "convex/values";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getErrorMessage } from "../../lib/errors";
import { createMcpHarness, seedTenantWithLeadGen } from "../../tests/mcpHarness";
import { api } from "../_generated/api";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function fixture() {
  const { t } = await createMcpHarness();
  const seed = await seedTenantWithLeadGen(t);
  const caller = t.withIdentity({ subject: "user_sofia", org_id: seed.orgId });
  return { t, caller };
}

describe("lead gen capture handle validation", () => {
  it("rejects a post URL with the form's coded sentence and writes no submission", async () => {
    const { t, caller } = await fixture();
    let rejection: unknown;
    try {
      await caller.mutation(api.leadGen.capture.submit, {
        source: "instagram",
        rawHandleOrProfileUrl: "instagram.com/p/abc",
        originKind: "follower",
      });
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(ConvexError);
    if (!(rejection instanceof ConvexError)) throw new Error("Expected a ConvexError");
    expect(rejection.data).toEqual({
      code: "lead_gen.invalid_instagram_handle",
      message: "Enter an Instagram handle or profile URL",
    });
    expect(getErrorMessage(rejection, "Capture failed")).toBe("Enter an Instagram handle or profile URL");
    expect(await t.run((ctx) => ctx.db.query("leadGenSubmissions").take(1))).toEqual([]);
  });

  it("submits a valid handle in the same fixture", async () => {
    const { t, caller } = await fixture();
    const result = await caller.mutation(api.leadGen.capture.submit, {
      source: "instagram",
      rawHandleOrProfileUrl: "real.handle",
      originKind: "follower",
    });
    expect(result.duplicateRetry).toBe(false);
    expect(await t.run((ctx) => ctx.db.get("leadGenSubmissions", result.submissionId))).toMatchObject({
      prospectId: result.prospectId,
      source: "instagram",
      originKind: "follower",
    });
  });
});
