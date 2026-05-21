"use node";

import { createHash } from "node:crypto";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action } from "../_generated/server";
import { verifyPortalSessionToken } from "./sessionToken";

function hashSessionId(jti: string) {
  return createHash("sha256").update(jti).digest("base64url");
}

export const recordCopyEvent = action({
  args: {
    portalSlug: v.string(),
    sessionToken: v.string(),
    eventTypeConfigId: v.id("eventTypeConfigs"),
    dmCloserId: v.id("dmClosers"),
    campaignPresetId: v.id("linkPortalCampaignPresets"),
  },
  handler: async (ctx, args): Promise<Id<"linkPortalCopyEvents">> => {
    const session = verifyPortalSessionToken(args.sessionToken);
    if (session.publicSlug !== args.portalSlug) {
      throw new Error("Portal session is no longer valid.");
    }

    return await ctx.runMutation(
      internal.linkPortal.copyMutations.insertCopyEvent,
      {
        tenantId: session.tenantId,
        publicSlug: args.portalSlug,
        sessionVersion: session.sessionVersion,
        sessionIdHash: hashSessionId(session.jti),
        eventTypeConfigId: args.eventTypeConfigId,
        dmCloserId: args.dmCloserId,
        campaignPresetId: args.campaignPresetId,
      },
    );
  },
});
