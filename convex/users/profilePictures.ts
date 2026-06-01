import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { mutation, type MutationCtx } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

const allowedProfilePictureTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

const maxProfilePictureBytes = 2 * 1024 * 1024;

const avatarRoles = [
  "tenant_master",
  "tenant_admin",
  "closer",
  "lead_generator",
] as const;

async function syncLeadGenWorkerProfile(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  userId: Id<"users">,
  customProfilePictureStorageId: Id<"_storage"> | undefined,
) {
  const worker = await ctx.db
    .query("leadGenWorkers")
    .withIndex("by_tenantId_and_userId", (q) =>
      q.eq("tenantId", tenantId).eq("userId", userId),
    )
    .unique();

  if (!worker) {
    return;
  }

  await ctx.db.patch(worker._id, {
    customProfilePictureStorageId,
    updatedAt: Date.now(),
  });
}

export const generateProfilePictureUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireTenantUser(ctx, [...avatarRoles]);
    return await ctx.storage.generateUploadUrl();
  },
});

export const saveProfilePicture = mutation({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, { storageId }) => {
    const { userId, tenantId } = await requireTenantUser(ctx, [
      ...avatarRoles,
    ]);
    const metadata = await ctx.db.system.get("_storage", storageId);

    if (!metadata) {
      throw new Error("Uploaded file was not found.");
    }

    if (
      !metadata.contentType ||
      !allowedProfilePictureTypes.has(metadata.contentType)
    ) {
      throw new Error(
        "Profile picture must be a JPEG, PNG, WebP, or GIF image.",
      );
    }

    if (metadata.size > maxProfilePictureBytes) {
      throw new Error("Profile picture must be 2 MB or smaller.");
    }

    const user = await ctx.db.get(userId);
    if (!user || user.tenantId !== tenantId) {
      throw new Error("User not found.");
    }

    const previousStorageId = user.customProfilePictureStorageId;
    const now = Date.now();

    await ctx.db.patch(userId, {
      customProfilePictureStorageId: storageId,
      customProfilePictureUploadedAt: now,
    });

    await syncLeadGenWorkerProfile(ctx, tenantId, userId, storageId);

    if (previousStorageId && previousStorageId !== storageId) {
      await ctx.storage.delete(previousStorageId);
    }

    return { storageId };
  },
});

export const removeProfilePicture = mutation({
  args: {},
  handler: async (ctx) => {
    const { userId, tenantId } = await requireTenantUser(ctx, [
      ...avatarRoles,
    ]);
    const user = await ctx.db.get(userId);
    if (!user || user.tenantId !== tenantId) {
      throw new Error("User not found.");
    }

    const previousStorageId = user.customProfilePictureStorageId;

    await ctx.db.patch(userId, {
      customProfilePictureStorageId: undefined,
      customProfilePictureUploadedAt: undefined,
    });

    await syncLeadGenWorkerProfile(ctx, tenantId, userId, undefined);

    if (previousStorageId) {
      await ctx.storage.delete(previousStorageId);
    }

    return { removed: Boolean(previousStorageId) };
  },
});
