import { env } from "../_generated/server";

type WorkosIdentityLike = {
  subject?: string | null;
  tokenIdentifier?: string | null;
};

function getUserManagementIssuer() {
  const clientId = env.WORKOS_CLIENT_ID;
  if (!clientId) {
    throw new Error("Missing WORKOS_CLIENT_ID");
  }
  return `https://api.workos.com/user_management/${clientId}`;
}

export function getRawWorkosUserId(workosUserId: string): string {
  const trimmed = workosUserId.trim();
  const separatorIndex = trimmed.lastIndexOf("|");
  return separatorIndex === -1 ? trimmed : trimmed.slice(separatorIndex + 1);
}

export function canonicalizeWorkosUserId(workosUserId: string): string {
  const trimmed = workosUserId.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.includes("|")) {
    return trimmed;
  }
  return `${getUserManagementIssuer()}|${trimmed}`;
}

export function getCanonicalIdentityWorkosUserId(
  identity: WorkosIdentityLike,
): string | null {
  const tokenIdentifier = identity.tokenIdentifier?.trim();
  if (tokenIdentifier) {
    return canonicalizeWorkosUserId(tokenIdentifier);
  }

  const subject = identity.subject?.trim();
  if (subject) {
    return canonicalizeWorkosUserId(subject);
  }

  return null;
}

/**
 * Every stored form a user's WorkOS ID may take, most specific first: the
 * identity's own `<issuer>|<id>`, the user-management form, then the raw ID.
 *
 * A token from another issuer, such as AuthKit's MCP tokens, yields
 * `<authkit>|<id>`. Users stored in the user-management form would match
 * neither that nor the raw ID, so the user-management form is always tried.
 */
export function getWorkosUserIdCandidates(workosUserId: string): string[] {
  const canonical = canonicalizeWorkosUserId(workosUserId);
  const raw = getRawWorkosUserId(workosUserId);
  // Every deployment declares WORKOS_CLIENT_ID as required. convex-test runs
  // without it, and an identity that already names its issuer must still
  // resolve there, so the form is skipped rather than thrown on.
  const userManagement =
    raw && env.WORKOS_CLIENT_ID ? `${getUserManagementIssuer()}|${raw}` : "";
  return [...new Set([canonical, userManagement, raw])].filter(Boolean);
}
