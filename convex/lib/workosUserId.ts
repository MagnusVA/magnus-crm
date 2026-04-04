type WorkosIdentityLike = {
  subject?: string | null;
  tokenIdentifier?: string | null;
};

function getUserManagementIssuer() {
  const clientId = process.env.WORKOS_CLIENT_ID;
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

export function getWorkosUserIdCandidates(workosUserId: string): string[] {
  const canonical = canonicalizeWorkosUserId(workosUserId);
  const raw = getRawWorkosUserId(workosUserId);
  return canonical === raw ? [canonical] : [canonical, raw];
}
