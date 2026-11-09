import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getCanonicalIdentityWorkosUserId, getWorkosUserIdCandidates } from "./workosUserId";

const UM = "https://api.workos.com/user_management/client_test";

describe("getWorkosUserIdCandidates", () => {
  beforeEach(() => vi.stubEnv("WORKOS_CLIENT_ID", "client_test"));
  afterEach(() => vi.unstubAllEnvs());

  test("a web token from the user-management issuer tries that form, then the raw ID", () => {
    const id = getCanonicalIdentityWorkosUserId({ tokenIdentifier: `${UM}|user_1` });
    expect(getWorkosUserIdCandidates(id!)).toEqual([`${UM}|user_1`, "user_1"]);
  });

  test("a raw ID tries the user-management form, then the raw ID", () => {
    expect(getWorkosUserIdCandidates("user_1")).toEqual([`${UM}|user_1`, "user_1"]);
  });

  test("an AuthKit MCP token also tries the user-management form", () => {
    const id = getCanonicalIdentityWorkosUserId({
      tokenIdentifier: "https://magnus.authkit.app|user_1",
    });
    expect(getWorkosUserIdCandidates(id!)).toEqual([
      "https://magnus.authkit.app|user_1",
      `${UM}|user_1`,
      "user_1",
    ]);
  });

  test("an SSO-issuer token also tries the user-management form", () => {
    expect(getWorkosUserIdCandidates("https://api.workos.com/|user_1")).toEqual([
      "https://api.workos.com/|user_1",
      `${UM}|user_1`,
      "user_1",
    ]);
  });
});
