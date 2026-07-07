import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export type MemberAvatarIdentity = {
  id: string;
  name: string | null;
  email?: string | null;
  imageUrl?: string | null;
  imageSource: "custom_storage" | "workos" | "slack" | "none";
  secondaryLabel?: string | null;
  isActive?: boolean | null;
  source: "crm_user" | "slack" | "dm_closer" | "system" | "unknown";
};

// Canonical runtime validator for MemberAvatarIdentity. Kept next to the
// type so the two cannot drift — dashboards embed this in `returns`
// validators, and a field mismatch there throws at runtime via returns
// validation. Must stay field-for-field identical to the type above.
export const memberAvatarIdentityValidator = v.object({
  id: v.string(),
  name: v.union(v.string(), v.null()),
  email: v.optional(v.union(v.string(), v.null())),
  imageUrl: v.optional(v.union(v.string(), v.null())),
  imageSource: v.union(
    v.literal("custom_storage"),
    v.literal("workos"),
    v.literal("slack"),
    v.literal("none"),
  ),
  secondaryLabel: v.optional(v.union(v.string(), v.null())),
  isActive: v.optional(v.union(v.boolean(), v.null())),
  source: v.union(
    v.literal("crm_user"),
    v.literal("slack"),
    v.literal("dm_closer"),
    v.literal("system"),
    v.literal("unknown"),
  ),
});

function nonEmptyString(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

async function storageUrl(
  ctx: QueryCtx | MutationCtx,
  storageId: Doc<"users">["customProfilePictureStorageId"],
) {
  return storageId ? await ctx.storage.getUrl(storageId) : null;
}

export async function userMemberIdentity(
  ctx: QueryCtx | MutationCtx,
  user: Doc<"users"> | null | undefined,
): Promise<MemberAvatarIdentity> {
  if (!user) {
    return unknownMemberIdentity("Removed user", "unknown");
  }

  const customUrl = await storageUrl(ctx, user.customProfilePictureStorageId);
  const workosUrl = nonEmptyString(user.profilePictureUrl);

  return {
    id: user._id,
    name: nonEmptyString(user.fullName) ?? user.email,
    email: user.email,
    imageUrl: customUrl ?? workosUrl,
    imageSource: customUrl ? "custom_storage" : workosUrl ? "workos" : "none",
    secondaryLabel: user.email,
    isActive: user.isActive,
    source: "crm_user",
  };
}

export async function leadGenWorkerMemberIdentity(
  ctx: QueryCtx,
  worker: Doc<"leadGenWorkers"> | null | undefined,
): Promise<MemberAvatarIdentity> {
  if (!worker) {
    return unknownMemberIdentity("Removed lead generator", "unknown");
  }

  const customUrl = await storageUrl(
    ctx,
    worker.customProfilePictureStorageId,
  );
  const workosUrl = nonEmptyString(worker.profilePictureUrl);

  return {
    id: worker._id,
    name: nonEmptyString(worker.displayName) ?? worker.email,
    email: worker.email,
    imageUrl: customUrl ?? workosUrl,
    imageSource: customUrl ? "custom_storage" : workosUrl ? "workos" : "none",
    secondaryLabel: worker.email,
    isActive: worker.isActive,
    source: "crm_user",
  };
}

export function slackMemberIdentity(
  slackUser: Doc<"slackUsers"> | null | undefined,
  fallbackId = "slack:unknown",
): MemberAvatarIdentity {
  const name =
    nonEmptyString(slackUser?.displayName) ??
    nonEmptyString(slackUser?.realName) ??
    nonEmptyString(slackUser?.username) ??
    "Slack user";
  const avatarUrl = nonEmptyString(slackUser?.avatarUrl);

  return {
    id: slackUser?._id ?? fallbackId,
    name,
    email: null,
    imageUrl: avatarUrl,
    imageSource: avatarUrl ? "slack" : "none",
    secondaryLabel: nonEmptyString(slackUser?.username),
    isActive: slackUser ? !slackUser.isDeleted : null,
    source: "slack",
  };
}

export async function dmCloserMemberIdentity(
  ctx: QueryCtx,
  dmCloser: Doc<"dmClosers">,
  linkedUser: Doc<"users"> | null | undefined,
): Promise<MemberAvatarIdentity> {
  if (linkedUser) {
    return await userMemberIdentity(ctx, linkedUser);
  }

  return {
    id: dmCloser._id,
    name: dmCloser.displayName,
    email: null,
    imageUrl: null,
    imageSource: "none",
    secondaryLabel: null,
    isActive: dmCloser.isActive,
    source: "dm_closer",
  };
}

export function publicDmCloserIdentity(
  dmCloser: Pick<Doc<"dmClosers">, "_id" | "displayName" | "isActive">,
): MemberAvatarIdentity {
  return {
    id: dmCloser._id,
    name: dmCloser.displayName,
    email: null,
    imageUrl: null,
    imageSource: "none",
    secondaryLabel: null,
    isActive: dmCloser.isActive,
    source: "dm_closer",
  };
}

export function unknownMemberIdentity(
  label: string,
  source: "system" | "unknown",
): MemberAvatarIdentity {
  return {
    id: source,
    name: label,
    email: null,
    imageUrl: null,
    imageSource: "none",
    secondaryLabel: null,
    isActive: null,
    source,
  };
}
