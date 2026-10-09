"use node";

import { WorkOS } from "@workos-inc/node";
import { v } from "convex/values";
import { internalAction, env } from "../_generated/server";
import { log } from "../lib/observability/log";
import { getRawWorkosUserId } from "../lib/workosUserId";

const workos = new WorkOS(env.WORKOS_API_KEY, {
  clientId: env.WORKOS_CLIENT_ID,
});

/**
 * Assign or update a WorkOS RBAC role for a user's organization membership.
 *
 * IMPORTANT: WorkOS role assignment requires the MEMBERSHIP ID, not the user ID.
 * We must first list memberships to find the membership ID, then update it.
 *
 * This is an internal action — only callable from other Convex functions.
 */
export const assignRoleToMembership = internalAction({
  args: {
    workosUserId: v.string(),
    organizationId: v.string(),
    roleSlug: v.union(
      v.literal("owner"),
      v.literal("tenant-admin"),
      v.literal("closer"),
    ),
  },
  handler: async (_ctx, { workosUserId, organizationId, roleSlug }) => {
    const startedAt = Date.now();
    const rawWorkosUserId = getRawWorkosUserId(workosUserId);

    // Step 1: Find the user's membership in this organization
    const memberships = await workos.userManagement.listOrganizationMemberships({
      userId: rawWorkosUserId,
      organizationId,
    });

    const membership = memberships.data[0];
    if (!membership) {
      // Thrown, so the failed execution is reported on its own.
      log.warn("workos.role.assign_failed", {
        outcome: "no_membership",
        workosUserId: rawWorkosUserId,
        organizationId,
        roleSlug,
        durationMs: Date.now() - startedAt,
      });
      throw new Error(
        `No membership found for user ${workosUserId} in org ${organizationId}`
      );
    }

    // Step 2: Update the membership with the new role slug
    const updated = await workos.userManagement.updateOrganizationMembership(
      membership.id,
      { roleSlug }
    );

    log.info("workos.role.assigned", {
      outcome: "assigned",
      workosUserId: rawWorkosUserId,
      organizationId,
      membershipId: membership.id,
      previousRoleSlug: membership.role?.slug,
      roleSlug,
      durationMs: Date.now() - startedAt,
    });

    return updated;
  },
});
