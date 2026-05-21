const MAX_UTM_LENGTH = 256;

export function normalizeUtmValue(value: string | undefined) {
  const raw = value?.trim();
  if (!raw) {
    return undefined;
  }
  return raw.toLowerCase().replace(/\s+/g, " ");
}

export function clampUtmValue(value: string | undefined) {
  if (value === undefined) {
    return { value: undefined, truncated: false };
  }
  if (value.length <= MAX_UTM_LENGTH) {
    return { value, truncated: false };
  }
  return { value: value.slice(0, MAX_UTM_LENGTH), truncated: true };
}

export function slugifyAttributionLabel(value: string) {
  return (
    normalizeUtmValue(value)
      ?.replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") ?? ""
  );
}
