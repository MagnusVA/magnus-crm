"use node";

import { WorkOS } from "@workos-inc/node";
import { internal } from "../_generated/api";
import { action } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { getIdentityOrgId } from "../lib/identity";
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

export const claimInvitedAccount = action({
  args: {},
  handler: async (ctx): Promise<Doc<"users"> | null> => {
    console.log("[WorkOS:Users] claimInvitedAccount action called");

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      console.warn("[WorkOS:Users] claimInvitedAccount action: not authenticated");
      return null;
    }

    const workosUserId = getCanonicalIdentityWorkosUserId(identity);
    if (!workosUserId) {
      console.warn("[WorkOS:Users] claimInvitedAccount action: no workosUserId");
      return null;
    }

    const orgId = getIdentityOrgId(identity);
    if (!orgId) {
      console.warn("[WorkOS:Users] claimInvitedAccount action: no orgId");
      return null;
    }

    const workosUser = await workos.userManagement.getUser(
      getRawWorkosUserId(workosUserId),
    );
    const email = workosUser.email?.trim().toLowerCase();

    if (!email) {
      console.warn("[WorkOS:Users] claimInvitedAccount action: WorkOS user missing email", {
        workosUserId,
      });
      return null;
    }

    console.log("[WorkOS:Users] claimInvitedAccount action: resolved WorkOS user", {
      workosUserId,
      orgId,
      email,
    });

    return await ctx.runMutation(
      internal.workos.userMutations.claimInvitedAccountByEmail,
      {
        workosUserId,
        orgId,
        email,
        fullName: getDisplayName(workosUser),
      },
    );
  },
});
