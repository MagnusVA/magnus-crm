# Phase 3 — Profile Page Upload

**Goal:** Let every authenticated CRM role upload, replace, and remove their own custom profile picture from `/workspace/profile`. After this phase, current-user queries return an avatar identity and custom Convex storage images take priority over WorkOS images.

**Prerequisite:** Phase 1A, 1B, and 1D are complete and generated Convex types include the optional avatar fields. Phase 2B and 2C exist. Convex file storage is available in the deployment.

**Runs in PARALLEL with:** Phase 4 surface rollout after 3A and 3B publish the current-user avatar payload. It does not block Phase 4 backend enrichment except where both modify `convex/users/queries.ts`; reserve that file for 3B until merged.

**Skills to invoke:**
- `convex` — file storage upload URLs, `_storage` metadata validation, tenant-authenticated mutations, and storage deletion.
- `frontend-design` — compact settings UI that fits the existing profile page.
- `shadcn` — Button/Card/Badge/Skeleton/Avatar composition and icon usage.
- `next-best-practices` — preserve the existing client component boundary for the profile page.
- `web-design-guidelines` — accessible file upload controls and loading/error states.

**Acceptance Criteria:**
1. `tenant_master`, `tenant_admin`, `closer`, and `lead_generator` users can generate a profile-picture upload URL only when authenticated as a tenant user.
2. `saveProfilePicture` validates `_storage` metadata server-side and rejects non-image files or files larger than 2 MB.
3. `saveProfilePicture` derives `userId` and `tenantId` from auth and never accepts a target user from the browser.
4. Replacing or removing a custom profile picture deletes the previously referenced storage object after the user row is patched.
5. Linked lead-gen worker rows receive the same custom storage ID when the current user is a lead generator.
6. `users.queries.getCurrentUser` returns a current-user `avatar` identity with custom storage images preferred over WorkOS.
7. `/workspace/profile` renders the current avatar, upload/replace button, remove icon button, and validation/network error states without controlling the file input value.
8. The profile loading state reserves avatar/control dimensions and includes `role="status"` plus an `aria-label`.
9. Upload, replace, remove, invalid type, oversize, and broken-image fallback states are manually verified for at least one CRM user.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
3A (storage mutations) ───────────┬── 3C (profile upload control) ───────┐
                                  │                                      ├── 3E (manual upload QA)
3B (current-user avatar query) ───┘                                      │
                                                                         │
3D (loading/error polish) ───────────────────────────────────────────────┘

3A + 3B complete ───────────────────────────────────────────────────────── Phase 4 can use current-user identity
```

**Optimal execution:**
1. Run 3A and 3B in parallel if one agent owns `convex/users/profilePictures.ts` and another owns `convex/users/queries.ts`.
2. Start 3C as soon as mutation names and the `getCurrentUser.avatar` shape are stable.
3. Run 3D alongside 3C because it owns the profile skeleton and error handling polish.
4. Finish with 3E before enabling custom uploads for production users.

**Estimated time:** 1.5-2.5 days

---

## Subphases

### 3A — Profile Picture Storage Mutations

**Type:** Backend
**Parallelizable:** Yes — owns a new file and depends only on Phase 1 generated types.

**What:** Add mutations to generate an upload URL, save a custom profile picture, and remove the current custom profile picture.

**Why:** Convex upload URLs can be generated after auth succeeds, but the returned storage ID is still untrusted client input until the save mutation validates `_storage` metadata and tenant identity.

**Where:**
- `convex/users/profilePictures.ts` (new)

**How:**

**Step 1: Create constants and upload URL mutation.**

```typescript
// Path: convex/users/profilePictures.ts
import { v } from "convex/values";
import { mutation } from "../_generated/server";
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

export const generateProfilePictureUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireTenantUser(ctx, [...avatarRoles]);
    return await ctx.storage.generateUploadUrl();
  },
});
```

**Step 2: Save a validated storage object to the current user.**

```typescript
// Path: convex/users/profilePictures.ts
export const saveProfilePicture = mutation({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, { storageId }) => {
    const { userId, tenantId } = await requireTenantUser(ctx, [...avatarRoles]);
    const metadata = await ctx.db.system.get("_storage", storageId);
    if (!metadata) throw new Error("Uploaded file was not found.");
    if (!metadata.contentType || !allowedProfilePictureTypes.has(metadata.contentType)) {
      throw new Error("Profile picture must be a JPEG, PNG, WebP, or GIF image.");
    }
    if (metadata.size > maxProfilePictureBytes) {
      throw new Error("Profile picture must be 2 MB or smaller.");
    }

    const user = await ctx.db.get(userId);
    if (!user || user.tenantId !== tenantId) throw new Error("User not found.");

    const previousStorageId = user.customProfilePictureStorageId;
    const now = Date.now();

    await ctx.db.patch(userId, {
      customProfilePictureStorageId: storageId,
      customProfilePictureUploadedAt: now,
    });

    const worker = await ctx.db
      .query("leadGenWorkers")
      .withIndex("by_tenantId_and_userId", (q) =>
        q.eq("tenantId", tenantId).eq("userId", userId),
      )
      .unique();
    if (worker) {
      await ctx.db.patch(worker._id, {
        customProfilePictureStorageId: storageId,
        updatedAt: now,
      });
    }

    if (previousStorageId && previousStorageId !== storageId) {
      await ctx.storage.delete(previousStorageId);
    }
  },
});
```

**Step 3: Remove the custom image and restore WorkOS/initials fallback.**

```typescript
// Path: convex/users/profilePictures.ts
export const removeProfilePicture = mutation({
  args: {},
  handler: async (ctx) => {
    const { userId, tenantId } = await requireTenantUser(ctx, [...avatarRoles]);
    const user = await ctx.db.get(userId);
    if (!user || user.tenantId !== tenantId) throw new Error("User not found.");

    const previousStorageId = user.customProfilePictureStorageId;
    await ctx.db.patch(userId, {
      customProfilePictureStorageId: undefined,
      customProfilePictureUploadedAt: undefined,
    });

    const worker = await ctx.db
      .query("leadGenWorkers")
      .withIndex("by_tenantId_and_userId", (q) =>
        q.eq("tenantId", tenantId).eq("userId", userId),
      )
      .unique();
    if (worker) {
      await ctx.db.patch(worker._id, {
        customProfilePictureStorageId: undefined,
        updatedAt: Date.now(),
      });
    }

    if (previousStorageId) {
      await ctx.storage.delete(previousStorageId);
    }
  },
});
```

**Key implementation notes:**
- Use `ctx.db.system.get("_storage", storageId)`, not deprecated storage metadata APIs.
- The mutation may leave a rare orphan if browser upload succeeds and `saveProfilePicture` is never called. Accept this for MVP and revisit only if storage growth is observed.
- Delete the previous file only after the database patch succeeds so the visible avatar is not broken on write failure.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/users/profilePictures.ts` | Create | Upload URL, save, and remove mutations. |

---

### 3B — Current User Avatar Query Shape

**Type:** Backend
**Parallelizable:** Yes — can run alongside 3A, but owns `convex/users/queries.ts`.

**What:** Return an avatar identity from `getCurrentUser`.

**Why:** The profile page, sidebar, and future current-user surfaces need a single current-user avatar payload without each client resolving image priority.

**Where:**
- `convex/users/queries.ts` (modify)

**How:**

**Step 1: Import and use the member identity helper.**

```typescript
// Path: convex/users/queries.ts
import { userMemberIdentity } from "../lib/memberIdentity";

export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    // Existing identity lookup stays unchanged.
    if (user?.isActive === false) {
      return null;
    }
    if (!user) return null;

    return {
      ...user,
      avatar: await userMemberIdentity(ctx, user),
    };
  },
});
```

**Step 2: Preserve current consumers.**

```typescript
// Path: convex/users/queries.ts
// Existing fields remain spread on the returned object so current profile,
// RoleProvider, and shell consumers keep working while Phase 4 adopts `avatar`.
```

**Key implementation notes:**
- Do not remove existing user fields in this phase.
- This query already derives user identity from AuthKit/Convex auth; keep that behavior.
- If returning signed URLs from `getCurrentUser` becomes noisy in logs, fix logging rather than moving URL resolution to the client.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/users/queries.ts` | Modify | Add `avatar` to current user payload. |

---

### 3C — Profile Upload Control

**Type:** Frontend
**Parallelizable:** Yes — starts after 3A and 3B API names are stable.

**What:** Add current avatar display, upload/replace button, remove icon button, client-side validation, and toast/error handling to `/workspace/profile`.

**Why:** The profile page is the authenticated self-service entry point. Admins should not manage other users' personal profile pictures in MVP.

**Where:**
- `app/workspace/profile/_components/profile-page-client.tsx` (modify)

**How:**

**Step 1: Add mutation imports and local upload state.**

```tsx
// Path: app/workspace/profile/_components/profile-page-client.tsx
"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { Trash2Icon, UploadIcon } from "lucide-react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { MemberAvatar } from "@/app/workspace/_components/member-avatar";
```

**Step 2: Add a compact control component.**

```tsx
// Path: app/workspace/profile/_components/profile-page-client.tsx
const allowedProfilePictureTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);
const maxProfilePictureBytes = 2 * 1024 * 1024;

type CurrentUser = NonNullable<FunctionReturnType<typeof api.users.queries.getCurrentUser>>;

function ProfilePictureControl({ user }: { user: CurrentUser }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const generateUploadUrl = useMutation(
    api.users.profilePictures.generateProfilePictureUploadUrl,
  );
  const saveProfilePicture = useMutation(api.users.profilePictures.saveProfilePicture);
  const removeProfilePicture = useMutation(api.users.profilePictures.removeProfilePicture);

  async function uploadProfilePicture(file: File) {
    if (!allowedProfilePictureTypes.has(file.type)) {
      toast.error("Profile picture must be a JPEG, PNG, WebP, or GIF image.");
      return;
    }
    if (file.size > maxProfilePictureBytes) {
      toast.error("Profile picture must be 2 MB or smaller.");
      return;
    }

    setIsUploading(true);
    try {
      const uploadUrl = await generateUploadUrl();
      const response = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!response.ok) throw new Error("Failed to upload profile picture.");

      const { storageId } = (await response.json()) as { storageId?: string };
      if (!storageId) throw new Error("Upload did not return a storage ID.");

      await saveProfilePicture({ storageId: storageId as Id<"_storage"> });
      toast.success("Profile picture updated.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Profile picture upload failed.");
    } finally {
      setIsUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="flex items-center gap-3">
      <MemberAvatar identity={user.avatar} size="lg" decorative={false} />
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void uploadProfilePicture(file);
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={isUploading}
        onClick={() => inputRef.current?.click()}
      >
        <UploadIcon data-icon="inline-start" />
        {user.avatar.imageSource === "custom_storage" ? "Replace" : "Upload"}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={isUploading || user.avatar.imageSource !== "custom_storage"}
        onClick={() => {
          void removeProfilePicture().then(() => toast.success("Profile picture removed."));
        }}
      >
        <Trash2Icon />
        <span className="sr-only">Remove profile picture</span>
      </Button>
    </div>
  );
}
```

**Step 3: Render the control in the account card header/content.**

```tsx
// Path: app/workspace/profile/_components/profile-page-client.tsx
<CardHeader>
  <CardTitle>Account</CardTitle>
  <CardDescription>
    Your profile is managed through your organization&apos;s identity provider.
  </CardDescription>
</CardHeader>
<CardContent>
  <div className="flex flex-col gap-5">
    <ProfilePictureControl user={user} />
    <Separator />
    {/* Existing InfoRow content remains below. */}
  </div>
</CardContent>
```

**Key implementation notes:**
- Do not pass a controlled `value` prop to the file input.
- Keep submission/network errors separate from file validation errors.
- Use lucide icons inside buttons and include an `sr-only` label on the remove icon button.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/profile/_components/profile-page-client.tsx` | Modify | Add upload/replace/remove controls. |

---

### 3D — Loading, Error, and Profile Layout Polish

**Type:** Frontend
**Parallelizable:** Yes — can run alongside 3C and owns loading/polish.

**What:** Update the profile loading skeleton and keep the account card layout stable while `getCurrentUser` loads.

**Why:** Adding an avatar row can introduce CLS if the loading state does not reserve the same dimensions.

**Where:**
- `app/workspace/profile/loading.tsx` (modify)
- `app/workspace/profile/_components/profile-page-client.tsx` (modify)

**How:**

**Step 1: Add avatar/control skeleton dimensions.**

```tsx
// Path: app/workspace/profile/loading.tsx
import { Skeleton } from "@/components/ui/skeleton";

export default function ProfileLoading() {
  return (
    <div
      role="status"
      aria-label="Loading profile"
      className="mx-auto flex max-w-2xl flex-col gap-6"
    >
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-36" />
        <Skeleton className="h-4 w-64" />
      </div>
      <div className="rounded-lg border bg-card p-6">
        <div className="flex items-center gap-3">
          <Skeleton className="size-10 rounded-full" />
          <Skeleton className="h-9 w-24" />
          <Skeleton className="size-9 rounded-md" />
        </div>
      </div>
    </div>
  );
}
```

**Step 2: Keep layout compact.**

```tsx
// Path: app/workspace/profile/_components/profile-page-client.tsx
// The profile page is a settings surface. Keep the avatar control in the
// existing Account card; do not add a hero, marketing copy, or separate page band.
```

**Key implementation notes:**
- Loading skeleton must include `role="status"` and `aria-label`.
- Avoid visible instructional text about how avatars work.
- The upload controls should not shift the existing name/email/role rows.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/profile/loading.tsx` | Modify | Add avatar upload skeleton dimensions. |
| `app/workspace/profile/_components/profile-page-client.tsx` | Modify | Keep compact account-card layout. |

---

### 3E — Upload QA Gate

**Type:** Manual / Full-Stack
**Parallelizable:** No — closes the profile upload feature before production use.

**What:** Verify storage, fallback, authorization, and cleanup behavior.

**Why:** File uploads are user-facing and create persistent storage. Failures should leave the previous avatar intact and should not expose another user's profile.

**Where:**
- `/workspace/profile` (manual)
- Convex dashboard / `npx convex data` (manual)
- `convex/users/profilePictures.ts` (verify)

**How:**

**Step 1: Run static checks.**

```bash
# Path: terminal
pnpm exec convex codegen
pnpm tsc --noEmit
```

**Step 2: Verify upload behavior by role.**

```bash
# Path: terminal
# Manual matrix:
# - tenant_master: upload, replace, remove
# - tenant_admin: upload, replace, remove
# - closer: upload, replace, remove
# - lead_generator: upload, replace, remove and confirm leadGenWorkers mirrors storage ID
```

**Step 3: Verify negative cases.**

```bash
# Path: terminal
# Manual cases:
# - Upload .txt -> rejected before save
# - Upload image > 2 MB -> rejected
# - Expired upload URL -> old avatar remains
# - Remove custom image -> WorkOS image or initials appears
# - Broken WorkOS URL -> Radix fallback initials appears
```

**Key implementation notes:**
- Record whether replacement deletes the old storage object.
- Do not test with production users outside the single test tenant.
- If server validation and client validation disagree, server validation wins.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/team-member-avatars/phases/phase3.md` | Reference | QA checklist and acceptance evidence. |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/users/profilePictures.ts` | Create | 3A |
| `convex/users/queries.ts` | Modify | 3B |
| `app/workspace/profile/_components/profile-page-client.tsx` | Modify | 3C, 3D |
| `app/workspace/profile/loading.tsx` | Modify | 3D |
| `plans/team-member-avatars/phases/phase3.md` | Reference | 3E |
