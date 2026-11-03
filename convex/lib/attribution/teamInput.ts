import { expectedError } from "../observability/errors";
import { normalizeUtmValue, slugifyAttributionLabel } from "./normalize";
import { validateRequiredString } from "../validation";

const RESERVED_UTM_SOURCE = "ptdom";

export function normalizeAttributionTeamInput(args: {
  displayName: string;
  utmSource: string;
}) {
  const displayName = args.displayName.trim();
  const utmSource = args.utmSource.trim();
  const displayNameValidation = validateRequiredString(displayName, {
    fieldName: "Team name",
    maxLength: 120,
  });
  if (!displayNameValidation.valid) {
    throw expectedError("attribution.rejected", displayNameValidation.error);
  }
  const utmSourceValidation = validateRequiredString(utmSource, {
    fieldName: "UTM source",
    maxLength: 256,
  });
  if (!utmSourceValidation.valid) {
    throw expectedError("attribution.rejected", utmSourceValidation.error);
  }
  const normalizedUtmSource = normalizeUtmValue(utmSource);
  if (!normalizedUtmSource) {
    throw expectedError("attribution.rejected", "UTM source is required.");
  }
  if (normalizedUtmSource === RESERVED_UTM_SOURCE) {
    throw expectedError("attribution.rejected", "UTM source ptdom is reserved for internal CRM links.");
  }
  const slug = slugifyAttributionLabel(displayName || utmSource);
  if (!slug) {
    throw expectedError("attribution.rejected", "Team name must contain at least one letter or number.");
  }
  return { displayName, utmSource, normalizedUtmSource, slug };
}

export function normalizeAttributionTeamFromName(name: string) {
  return normalizeAttributionTeamInput({
    displayName: name,
    utmSource: name,
  });
}
