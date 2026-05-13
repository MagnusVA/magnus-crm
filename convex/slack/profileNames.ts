type SlackUserProfilePayload = {
  name?: unknown;
  real_name?: unknown;
  profile?: {
    display_name?: unknown;
    display_name_normalized?: unknown;
    real_name?: unknown;
    real_name_normalized?: unknown;
    image_72?: unknown;
  };
  tz?: unknown;
};

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function hasSlackDisplayName(value: unknown): boolean {
  return nonEmptyString(value) !== undefined;
}

export function normalizeSlackUserProfile(user: SlackUserProfilePayload) {
  const username = nonEmptyString(user.name);
  const realName =
    nonEmptyString(user.real_name) ??
    nonEmptyString(user.profile?.real_name) ??
    nonEmptyString(user.profile?.real_name_normalized);
  const displayName =
    nonEmptyString(user.profile?.display_name) ??
    nonEmptyString(user.profile?.display_name_normalized) ??
    realName ??
    username;

  return {
    username,
    realName,
    displayName,
    avatarUrl: nonEmptyString(user.profile?.image_72),
    timezone: nonEmptyString(user.tz),
  };
}
