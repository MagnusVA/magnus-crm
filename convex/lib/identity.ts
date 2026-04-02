/**
 * Extract the organization ID from a Convex user identity.
 *
 * WorkOS JWTs may place the org claim under different keys depending
 * on the SDK version and token type. This function checks all known
 * variants in priority order.
 *
 * @returns The organization ID string, or undefined if no org claim is present.
 */
export function getIdentityOrgId(
  identity: Record<string, unknown>,
): string | undefined {
  return (
    (identity.organization_id as string | undefined) ??
    (identity.organizationId as string | undefined) ??
    (identity.org_id as string | undefined)
  );
}
