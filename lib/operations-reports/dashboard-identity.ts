import type { MemberAvatarIdentity } from "@/convex/lib/memberIdentity";
import type { ScalarRecord } from "@/convex/operations/reports/contracts";

/** Rehydrate the canonical member identity from the report's scalar payload. */
export function dashboardIdentity(fields: ScalarRecord, fallbackId: string, fallbackName: string): MemberAvatarIdentity {
  const imageSource = fields.identityImageSource;
  const source = fields.identitySource;
  const nullableString = (value: unknown) => typeof value === "string" ? value : null;
  return {
    id: nullableString(fields.identityId) ?? fallbackId,
    name: nullableString(fields.identityName) ?? fallbackName,
    email: nullableString(fields.identityEmail),
    imageUrl: nullableString(fields.identityImageUrl),
    imageSource: imageSource === "custom_storage" || imageSource === "workos" || imageSource === "slack" ? imageSource : "none",
    secondaryLabel: nullableString(fields.identitySecondaryLabel),
    isActive: typeof fields.identityIsActive === "boolean" ? fields.identityIsActive : null,
    source: source === "crm_user" || source === "slack" || source === "dm_closer" || source === "system" ? source : "unknown",
  };
}
