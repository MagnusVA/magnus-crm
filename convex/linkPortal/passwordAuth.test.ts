import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bookingHarness } from "../../tests/bookingHarness";
import { getErrorCode, getErrorMessage } from "../../lib/errors";
import { api } from "../_generated/api";
import { GENERIC_PORTAL_AUTH_ERROR, PORTAL_AUTH_FAILED_CODE } from "./authFailure";

const PASSWORD = "correct-portal-password";
const IP_HASH = "ipHashForTest_0123456789";
const AUTH_FAILURE = {
  code: PORTAL_AUTH_FAILED_CODE,
  message: GENERIC_PORTAL_AUTH_ERROR,
};

describe("portal password authentication", () => {
  let harness: Awaited<ReturnType<typeof bookingHarness>>;
  let portalSlug: string;

  beforeEach(async () => {
    harness = await bookingHarness();
    const rotation = await harness.admin.action(api.linkPortal.passwordActions.rotatePortalPassword, {
      password: PASSWORD,
    });
    portalSlug = rotation.publicSlug;
    await harness.admin.mutation(api.linkPortal.configMutations.setPortalEnabled, { isEnabled: true });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("a wrong password is rejected with the portal's code and sentence", async () => {
    const error = await harness.t.action(api.linkPortal.passwordActions.verifyPassword, {
      portalSlug, password: "wrong-password", ipHash: IP_HASH,
    }).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(ConvexError);
    expect(error instanceof ConvexError ? error.data : undefined).toEqual(AUTH_FAILURE);
    expect(getErrorCode(error)).toBe(PORTAL_AUTH_FAILED_CODE);
    expect(getErrorMessage(error, "fallback")).toBe(GENERIC_PORTAL_AUTH_ERROR);
  });

  it("a wrong password records a failed attempt and the fifth locks the address out for 15 minutes", async () => {
    const { t, tenantId } = harness;
    for (let i = 1; i <= 5; i += 1) {
      const error = await t.action(api.linkPortal.passwordActions.verifyPassword, {
        portalSlug, password: "wrong-password", ipHash: IP_HASH,
      }).catch((error: unknown) => error);

      expect(error).toBeInstanceOf(ConvexError);
      expect(error instanceof ConvexError ? error.data : undefined).toEqual(AUTH_FAILURE);
      const attempt = await t.run((ctx) => ctx.db.query("linkPortalAuthAttempts")
        .withIndex("by_tenantId_and_ipHash", (q) => q.eq("tenantId", tenantId).eq("ipHash", IP_HASH))
        .unique());
      expect(attempt?.failedCount).toBe(i);
      if (i < 5) {
        expect(attempt?.lockedUntil).toBeUndefined();
      } else {
        expect(attempt?.lockedUntil).toEqual(expect.any(Number));
        expect(attempt!.lockedUntil! - attempt!.updatedAt).toBe(15 * 60 * 1000);
      }
    }

    const lockedAttempt = await t.run((ctx) => ctx.db.query("linkPortalAuthAttempts")
      .withIndex("by_tenantId_and_ipHash", (q) => q.eq("tenantId", tenantId).eq("ipHash", IP_HASH))
      .unique());
    const error = await t.action(api.linkPortal.passwordActions.verifyPassword, {
      portalSlug, password: PASSWORD, ipHash: IP_HASH,
    }).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(ConvexError);
    expect(error instanceof ConvexError ? error.data : undefined).toEqual(AUTH_FAILURE);
    const afterLockout = await t.run((ctx) => ctx.db.query("linkPortalAuthAttempts")
      .withIndex("by_tenantId_and_ipHash", (q) => q.eq("tenantId", tenantId).eq("ipHash", IP_HASH))
      .unique());
    expect(afterLockout).toEqual(lockedAttempt);
    expect(afterLockout?.failedCount).toBe(5);
    expect(afterLockout?.lockedUntil).toBe(lockedAttempt?.lockedUntil);
  });

  it("a password of invalid length counts as a failed attempt", async () => {
    const { t, tenantId } = harness;
    const error = await t.action(api.linkPortal.passwordActions.verifyPassword, {
      portalSlug, password: "short", ipHash: IP_HASH,
    }).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(ConvexError);
    expect(error instanceof ConvexError ? error.data : undefined).toEqual(AUTH_FAILURE);
    const attempt = await t.run((ctx) => ctx.db.query("linkPortalAuthAttempts")
      .withIndex("by_tenantId_and_ipHash", (q) => q.eq("tenantId", tenantId).eq("ipHash", IP_HASH))
      .unique());
    expect(attempt?.failedCount).toBe(1);
  });

  it("a disabled portal and an unknown portal are rejected the same way, and count nothing", async () => {
    const { t, tenantId, admin } = harness;
    await admin.mutation(api.linkPortal.configMutations.setPortalEnabled, { isEnabled: false });
    for (const slug of [portalSlug, "lp_unknown_portal"]) {
      const error = await t.action(api.linkPortal.passwordActions.verifyPassword, {
        portalSlug: slug, password: PASSWORD, ipHash: IP_HASH,
      }).catch((error: unknown) => error);

      expect(error).toBeInstanceOf(ConvexError);
      expect(error instanceof ConvexError ? error.data : undefined).toEqual(AUTH_FAILURE);
      expect(await t.run((ctx) => ctx.db.query("linkPortalAuthAttempts")
        .withIndex("by_tenantId_and_ipHash", (q) => q.eq("tenantId", tenantId).eq("ipHash", IP_HASH))
        .unique())).toBeNull();
    }
  });

  it("malformed input is rejected the same way", async () => {
    const error = await harness.t.action(api.linkPortal.passwordActions.verifyPassword, {
      portalSlug, password: PASSWORD, ipHash: "bad",
    }).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(ConvexError);
    expect(error instanceof ConvexError ? error.data : undefined).toEqual(AUTH_FAILURE);
  });

  it("the right password signs in and clears the failed attempts", async () => {
    vi.stubEnv("LINK_PORTAL_SESSION_SECRET", "test-portal-session-secret-at-least-32-characters");
    const { t, tenantId } = harness;
    for (let i = 0; i < 2; i += 1) {
      await expect(t.action(api.linkPortal.passwordActions.verifyPassword, {
        portalSlug, password: "wrong-password", ipHash: IP_HASH,
      })).rejects.toBeInstanceOf(ConvexError);
    }
    expect(await t.run((ctx) => ctx.db.query("linkPortalAuthAttempts")
      .withIndex("by_tenantId_and_ipHash", (q) => q.eq("tenantId", tenantId).eq("ipHash", IP_HASH))
      .unique())).toMatchObject({ failedCount: 2 });

    const session = await t.action(api.linkPortal.passwordActions.verifyPassword, {
      portalSlug, password: PASSWORD, ipHash: IP_HASH,
    });
    expect(session.sessionToken).toEqual(expect.any(String));
    expect(session.maxAgeSeconds).toEqual(expect.any(Number));
    expect(await t.run((ctx) => ctx.db.query("linkPortalAuthAttempts")
      .withIndex("by_tenantId_and_ipHash", (q) => q.eq("tenantId", tenantId).eq("ipHash", IP_HASH))
      .unique())).toBeNull();
  });

  it("an enabled portal whose stored password can't be checked stays a plain Error (a bug, not a rejection)", async () => {
    const { t, tenantId } = harness;
    await t.run(async (ctx) => {
      const config = (await ctx.db.query("linkPortalConfigs")
        .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId)).unique())!;
      await ctx.db.patch("linkPortalConfigs", config._id, { passwordHash: undefined });
    });
    const error = await t.action(api.linkPortal.passwordActions.verifyPassword, {
      portalSlug, password: PASSWORD, ipHash: IP_HASH,
    }).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ConvexError);
    expect(getErrorCode(error)).toBeUndefined();
  });
});
