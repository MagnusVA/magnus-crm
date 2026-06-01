"use node";

import { WorkOS } from "@workos-inc/node";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action } from "../_generated/server";
import {
  getCanonicalIdentityWorkosUserId,
  getRawWorkosUserId,
} from "../lib/workosUserId";

const workos = new WorkOS(process.env.WORKOS_API_KEY!, {
  clientId: process.env.WORKOS_CLIENT_ID!,
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
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    const workosUserId = getCanonicalIdentityWorkosUserId(identity);
    if (!workosUserId) {
      throw new Error("Missing WorkOS user ID");
    }

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
