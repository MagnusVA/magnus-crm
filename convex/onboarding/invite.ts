"use node";

import { v } from "convex/values";
import { action } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { hashInviteToken, validateInviteToken } from "../lib/inviteToken";

export const validateInvite = action({
  args: { token: v.string() },
  handler: async (
    ctx,
    { token },
  ): Promise<
    | {
        valid: true;
        tenantId: Id<"tenants">;
        companyName: string;
        workosOrgId: string;
        contactEmail: string;
      }
    | {
        valid: false;
        error:
          | "invalid_signature"
          | "not_found"
          | "already_redeemed"
          | "expired";
        workosOrgId?: string;
        companyName?: string;
      }
  > => {
    const signingSecret = process.env.INVITE_SIGNING_SECRET;
    if (!signingSecret) {
      throw new Error("Missing INVITE_SIGNING_SECRET");
    }

    const payload = validateInviteToken(token, signingSecret);
    if (!payload) {
      return { valid: false as const, error: "invalid_signature" as const };
    }

    const tenant: Doc<"tenants"> | null = await ctx.runQuery(
      internal.tenants.getByInviteTokenHash,
      {
        inviteTokenHash: hashInviteToken(token),
      },
    );

    if (!tenant) {
      return { valid: false as const, error: "not_found" as const };
    }

    if (tenant.inviteRedeemedAt !== undefined) {
      return {
        valid: false as const,
        error: "already_redeemed" as const,
        workosOrgId: tenant.workosOrgId,
        companyName: tenant.companyName,
      };
    }

    if (Date.now() > tenant.inviteExpiresAt) {
      return {
        valid: false as const,
        error: "expired" as const,
        workosOrgId: tenant.workosOrgId,
        companyName: tenant.companyName,
      };
    }

    return {
      valid: true as const,
      tenantId: tenant._id,
      companyName: tenant.companyName,
      workosOrgId: tenant.workosOrgId,
      contactEmail: tenant.contactEmail,
    };
  },
});
