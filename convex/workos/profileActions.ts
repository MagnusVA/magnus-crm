"use node";

import { WorkOS } from "@workos-inc/node";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, env } from "../_generated/server";
import { rejectRequest } from "../lib/observability/errors";
import { logRequestContext } from "../lib/observability/log";
import { getIdentityOrgId } from "../lib/identity";
import {
  getCanonicalIdentityWorkosUserId,
  getRawWorkosUserId,
} from "../lib/workosUserId";
import { requireIdentity } from "../requireIdentity";

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

export const syncCurrentProfile = action({
  args: {},
  handler: async (ctx): Promise<Id<"users"> | null> => {
    const identity = await requireIdentity(ctx);

    const workosUserId = getCanonicalIdentityWorkosUserId(identity);
    if (!workosUserId) {
      throw rejectRequest(
        "auth.missing_workos_user_id",
        "Missing WorkOS user ID",
      );
    }
    logRequestContext({
      distinctId: getRawWorkosUserId(workosUserId),
      workosOrgId: getIdentityOrgId(identity),
    });

    const workosUser = await workos.userManagement.getUser(
      getRawWorkosUserId(workosUserId),
    );

    return await ctx.runMutation(
      internal.workos.profileMutations.patchCurrentProfile,
      {
        workosUserId,
        email: workosUser.email,
        fullName: getDisplayName(workosUser),
        profilePictureUrl: workosUser.profilePictureUrl ?? undefined,
        syncedAt: Date.now(),
      },
    );
  },
});
