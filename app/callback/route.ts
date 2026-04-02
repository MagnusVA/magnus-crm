import {
  getWorkOS,
  handleAuth,
  saveSession,
} from "@workos-inc/authkit-nextjs";

function getOnboardingOrgId(state: string | undefined) {
  if (!state) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(state) as { onboardingOrgId?: unknown };
    return typeof parsed.onboardingOrgId === "string"
      ? parsed.onboardingOrgId
      : undefined;
  } catch {
    return undefined;
  }
}

export const GET = handleAuth({
  onSuccess: async ({
    refreshToken,
    user,
    organizationId,
    state,
  }) => {
    const onboardingOrgId = getOnboardingOrgId(state);
    if (!organizationId && onboardingOrgId) {
      const workos = getWorkOS();
      const memberships = await workos.userManagement.listOrganizationMemberships(
        {
          organizationId: onboardingOrgId,
          userId: user.id,
        },
      );

      const existingMembership = memberships.data[0];
      if (!existingMembership) {
        try {
          await workos.userManagement.createOrganizationMembership({
            organizationId: onboardingOrgId,
            userId: user.id,
          });
        } catch (error) {
          console.error("[callback] Failed to create org membership:", error);
          // Don't fail the auth callback; the user can retry login
        }
      }

      const refreshedSession =
        await workos.userManagement.authenticateWithRefreshToken({
          clientId: process.env.WORKOS_CLIENT_ID!,
          refreshToken,
          organizationId: onboardingOrgId,
        });

      await saveSession(
        {
          accessToken: refreshedSession.accessToken,
          refreshToken: refreshedSession.refreshToken,
          user: refreshedSession.user,
          impersonator: refreshedSession.impersonator,
        },
        process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI ?? "http://localhost:3000/callback",
      );
    }
  },
});
