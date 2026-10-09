"use node";

import { WorkOS } from "@workos-inc/node";
import { internal } from "../_generated/api";
import { action, env } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { getIdentityOrgId } from "../lib/identity";
import { log } from "../lib/observability/log";
import {
  getCanonicalIdentityWorkosUserId,
  getRawWorkosUserId,
} from "../lib/workosUserId";

const workos = new WorkOS(env.WORKOS_API_KEY, {
  clientId: env.WORKOS_CLIENT_ID,
});

function getDisplayName(user: {
  firstName?: string | null;
  lastName?: string | null;
}) {
  const fullName = [user.firstName, user.lastName]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join(" ")
    .trim();

  return fullName || undefined;
}

// eslint-disable-next-line @convex-dev/require-access-control -- returns null when signed out; claims only the caller's invite
export const claimInvitedAccount = action({
  args: {},
  handler: async (ctx): Promise<Doc<"users"> | null> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      log.warn("workos.user.invite_claim_skipped", { reason: "not_authenticated" });
      return null;
    }

    const workosUserId = getCanonicalIdentityWorkosUserId(identity);
    if (!workosUserId) {
      log.warn("workos.user.invite_claim_skipped", { reason: "missing_workos_user_id" });
      return null;
    }

    const orgId = getIdentityOrgId(identity);
    if (!orgId) {
      log.warn("workos.user.invite_claim_skipped", { reason: "missing_org_id" });
      return null;
    }

    const workosUser = await workos.userManagement.getUser(
      getRawWorkosUserId(workosUserId),
    );
    const email = workosUser.email?.trim().toLowerCase();

    if (!email) {
      log.warn("workos.user.invite_claim_skipped", {
        reason: "workos_user_missing_email",
        workosOrgId: orgId,
      });
      return null;
    }

    return await ctx.runMutation(
      internal.workos.userMutations.claimInvitedAccountByEmail,
      {
        workosUserId,
        orgId,
        email,
        fullName: getDisplayName(workosUser),
        profilePictureUrl: workosUser.profilePictureUrl ?? undefined,
        profilePictureSyncedAt: Date.now(),
      },
    );
  },
});
