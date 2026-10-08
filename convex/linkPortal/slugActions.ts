"use node";

import { randomBytes } from "node:crypto";
import { action } from "../_generated/server";
import { internal } from "../_generated/api";
import { requireTenantUserFromAction } from "../requireTenantUserFromAction";

type RotatePortalSlugResult = {
  portalUrlPath: string;
  publicSlug: string;
  sessionVersion: number;
};

function randomPortalSlug() {
  return `lp_${randomBytes(18).toString("base64url")}`;
}

function isSlugCollision(error: unknown) {
  return error instanceof Error && error.message.includes("Portal slug collision");
}

export const rotatePortalSlug = action({
  args: {},
  handler: async (ctx): Promise<RotatePortalSlugResult> => {
    const access = await requireTenantUserFromAction(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result: RotatePortalSlugResult = await ctx.runMutation(
          internal.linkPortal.configMutations.rotatePublicSlug,
          {
            tenantId: access.tenantId,
            publicSlug: randomPortalSlug(),
          },
        );
        return result;
      } catch (error) {
        if (!isSlugCollision(error) || attempt === 2) {
          throw error;
        }
      }
    }

    throw new Error("Portal configuration could not be saved.");
  },
});
