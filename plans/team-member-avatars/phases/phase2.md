# Phase 2 — Shared Avatar UI

**Goal:** Create the reusable workspace avatar components and fallback helpers used by every team-member surface. After this phase, frontend work can render a consistent circular image/initials identity row without duplicating Radix Avatar markup.

**Prerequisite:** Phase 1B has published the `MemberAvatarIdentity` contract. `components/ui/avatar.tsx` already exists and must remain the primitive wrapper.

**Runs in PARALLEL with:** Phase 1C, 1D, and 1E after Phase 1B. Phase 3 can start after 2B and 2C exist. Phase 4 can start after 2D lands and the components are typechecked.

**Skills to invoke:**
- `frontend-design` — dense operational UI consistency, compact table rows, and responsive fit.
- `shadcn` — compose the existing Avatar/Button/Card primitives and preserve radix-nova conventions.
- `next-best-practices` — keep interactive helpers in client components and pass only serializable props across RSC boundaries.
- `web-design-guidelines` — verify accessible labels, fallback states, and no layout shift.

**Acceptance Criteria:**
1. `MemberAvatar` renders a circular image when `identity.imageUrl` is present and a deterministic initials fallback when it is not.
2. `MemberIdentity` renders avatar, display name, optional secondary label, and optional badge in one truncation-safe row.
3. Unknown, removed, system, one-word, email-only, and empty-name identities have deterministic fallbacks.
4. Avatar components expose stable `sm`, `default`, and `lg` sizing without resizing their parent row on image load failure.
5. Avatar images are decorative when adjacent text is present and labeled when the avatar is used alone.
6. Components use the repo's shadcn `Avatar`, `AvatarImage`, and `AvatarFallback` primitives rather than custom circles.
7. No app surface is rolled out in bulk during this phase; only shared components and optional local fixture usage are added.
8. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
2A (type + initials helper) ─────┬── 2B (MemberAvatar) ─────────────┐
                                 └── 2C (MemberIdentity) ──────────┤
                                                                    ├── 2E (docs + fixture checks)
2D (size/accessibility polish) ─────────────────────────────────────┘

2B + 2C complete ───────────────────────────────────────────────────── Phase 3 can start
2E complete ────────────────────────────────────────────────────────── Phase 4 can fan out
```

**Optimal execution:**
1. Start 2A immediately after Phase 1B.
2. Run 2B and 2C in parallel because they can be implemented in separate files once the shared helper exists.
3. Run 2D in parallel as a focused polish pass against the shadcn primitive.
4. Finish with 2E so Phase 4 agents have exact usage rules and import paths.

**Estimated time:** 0.5-1.5 days

---

## Subphases

### 2A — Identity Type and Initials Helper

**Type:** Frontend
**Parallelizable:** No — the other UI components import this type/helper.

**What:** Create the frontend identity type and deterministic fallback initials function.

**Why:** Every surface needs the same fallback behavior. Without one helper, initials drift across tables, cards, dialogs, and filter options.

**Where:**
- `app/workspace/_components/member-avatar.tsx` (new)

**How:**

**Step 1: Define the type and fallback helper.**

```tsx
// Path: app/workspace/_components/member-avatar.tsx
"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

export type MemberAvatarIdentity = {
  id: string;
  name: string | null;
  email?: string | null;
  imageUrl?: string | null;
  imageSource?: "custom_storage" | "workos" | "slack" | "none";
  secondaryLabel?: string | null;
  isActive?: boolean | null;
  source: "crm_user" | "slack" | "dm_closer" | "system" | "unknown";
};

export function getMemberInitials(name?: string | null, email?: string | null) {
  const base = (name?.trim() || email?.split("@")[0]?.trim() || "").replace(/\s+/g, " ");
  if (!base) return "?";

  const parts = base.split(" ").filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
  }

  return base.slice(0, 2).toUpperCase();
}
```

**Key implementation notes:**
- Keep this helper pure and browser-safe.
- Do not import Convex server types into this client file.
- Use `?` only when there is no stable display name or email prefix.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/_components/member-avatar.tsx` | Create | Shared type and initials helper. |

---

### 2B — MemberAvatar Component

**Type:** Frontend
**Parallelizable:** Yes — depends only on 2A and can run alongside 2C.

**What:** Wrap the existing shadcn `Avatar` primitive with the member identity contract, image source handling, and fallback text.

**Why:** Tables and compact surfaces should not duplicate `AvatarImage`, `AvatarFallback`, `referrerPolicy`, image alt, or initials logic.

**Where:**
- `app/workspace/_components/member-avatar.tsx` (modify)

**How:**

**Step 1: Add the component below the helper.**

```tsx
// Path: app/workspace/_components/member-avatar.tsx
export function MemberAvatar({
  identity,
  size = "sm",
  className,
  decorative = true,
}: {
  identity: MemberAvatarIdentity;
  size?: "sm" | "default" | "lg";
  className?: string;
  decorative?: boolean;
}) {
  const label = identity.name ?? identity.email ?? "Unknown";
  const initials = getMemberInitials(identity.name, identity.email);

  return (
    <Avatar
      size={size}
      className={cn("bg-muted", className)}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative ? true : undefined}
    >
      <AvatarImage
        src={identity.imageUrl ?? undefined}
        alt=""
        referrerPolicy="no-referrer"
      />
      <AvatarFallback className="font-medium uppercase">
        {initials}
      </AvatarFallback>
    </Avatar>
  );
}
```

**Key implementation notes:**
- Keep `alt=""` because the adjacent row text is the accessible name in most surfaces.
- Use `decorative={false}` only for icon-only contexts.
- Do not manually set `width`/`height`; the shadcn Avatar `size` prop owns stable dimensions.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/_components/member-avatar.tsx` | Modify | Add shared avatar wrapper. |

---

### 2C — MemberIdentity Row Component

**Type:** Frontend
**Parallelizable:** Yes — depends only on 2A and 2B.

**What:** Create a reusable avatar + name + secondary label row for tables, cards, dialogs, and option lists.

**Why:** Most workspace surfaces need the same compact identity row. Centralizing the row keeps truncation, inactive badges, and secondary labels consistent.

**Where:**
- `app/workspace/_components/member-identity.tsx` (new)

**How:**

**Step 1: Create the row component.**

```tsx
// Path: app/workspace/_components/member-identity.tsx
"use client";

import type { ReactNode } from "react";
import { MemberAvatar, type MemberAvatarIdentity } from "./member-avatar";
import { cn } from "@/lib/utils";

export function MemberIdentity({
  identity,
  badge,
  size = "sm",
  className,
}: {
  identity: MemberAvatarIdentity;
  badge?: ReactNode;
  size?: "sm" | "default" | "lg";
  className?: string;
}) {
  const name = identity.name ?? identity.email ?? "Unknown";
  const secondaryLabel =
    identity.secondaryLabel ?? (identity.email && identity.email !== name ? identity.email : null);

  return (
    <div className={cn("flex min-w-0 items-center gap-2.5", className)}>
      <MemberAvatar identity={identity} size={size} />
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium">{name}</span>
          {badge}
        </div>
        {secondaryLabel ? (
          <p className="truncate text-xs text-muted-foreground">
            {secondaryLabel}
          </p>
        ) : null}
      </div>
    </div>
  );
}
```

**Step 2: Reserve select-option usage for stable menus.**

```tsx
// Path: app/workspace/_components/member-identity.tsx
export function MemberIdentityOption({
  identity,
}: {
  identity: MemberAvatarIdentity;
}) {
  return (
    <MemberIdentity
      identity={identity}
      className="w-full"
      size="sm"
    />
  );
}
```

**Key implementation notes:**
- Keep `min-w-0` at each text container to prevent overflow in narrow tables.
- Do not put explanatory text beside avatars; the row itself is the information.
- `badge` is for status such as inactive/pending, not for image source labels.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/_components/member-identity.tsx` | Create | Shared identity row and option variant. |

---

### 2D — Size, Accessibility, and Loading Polish

**Type:** Frontend
**Parallelizable:** Yes — can run after 2B and can be reviewed independently from rollout work.

**What:** Verify size behavior against `components/ui/avatar.tsx`, define icon-only accessibility usage, and create skeleton guidance for loading states.

**Why:** Phase 4 will touch many dense surfaces. Stable dimensions and accessible labels need to be settled before multiple agents replicate the pattern.

**Where:**
- `app/workspace/_components/member-avatar.tsx` (modify)
- `app/workspace/_components/member-identity.tsx` (modify)
- `components/ui/avatar.tsx` (verify only unless a local bug is found)

**How:**

**Step 1: Keep size usage aligned with the shadcn primitive.**

```tsx
// Path: app/workspace/_components/member-avatar.tsx
// Use:
// - size="sm" for table rows and menu options.
// - size="default" for cards and detail rows.
// - size="lg" for the profile page account header.
```

**Step 2: Add an icon-only example for callers.**

```tsx
// Path: app/workspace/_components/member-avatar.tsx
<MemberAvatar
  identity={currentUserIdentity}
  size="default"
  decorative={false}
/>
```

**Step 3: Add a skeleton pattern for Phase 3/4.**

```tsx
// Path: app/workspace/profile/loading.tsx
import { Skeleton } from "@/components/ui/skeleton";

export function MemberIdentitySkeleton() {
  return (
    <div role="status" aria-label="Loading member" className="flex items-center gap-2.5">
      <Skeleton className="size-8 rounded-full" />
      <div className="flex min-w-0 flex-col gap-1">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-44" />
      </div>
    </div>
  );
}
```

**Key implementation notes:**
- Use `Skeleton`; do not create custom pulse blocks.
- The skeleton dimensions must match the eventual avatar size to avoid CLS.
- Only modify `components/ui/avatar.tsx` if it cannot preserve stable size or fallback behavior.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/_components/member-avatar.tsx` | Modify | Add usage notes if needed. |
| `app/workspace/_components/member-identity.tsx` | Modify | Confirm option row behavior. |
| `components/ui/avatar.tsx` | Verify | Existing primitive should remain unchanged. |

---

### 2E — Shared Usage Rules and Verification

**Type:** Frontend / Manual
**Parallelizable:** No — closes the component contract before Phase 4 rollout fans out.

**What:** Document component usage rules in the phase plan and run typecheck/static search against existing manual avatar markup.

**Why:** Multiple agents will update surfaces in Phase 4. They need a clear rule for when to use `MemberIdentity` versus `MemberAvatar`.

**Where:**
- `plans/team-member-avatars/phases/phase2.md` (reference)
- `app/workspace/_components/member-avatar.tsx` (verify)
- `app/workspace/_components/member-identity.tsx` (verify)

**How:**

**Step 1: Use this decision rule during Phase 4.**

```tsx
// Path: app/workspace/_components/member-identity.tsx
// Use MemberIdentity when the component owns the visible name.
// Use MemberAvatar when the surrounding layout already renders the name.
// Use public initials-only identities for unauthenticated portal surfaces.
```

**Step 2: Find manual avatar markup to prioritize in Phase 4.**

```bash
# Path: terminal
rg "AvatarImage|AvatarFallback|rounded-full.*initial|authorName|actorName|closerName" app convex
```

**Step 3: Run static validation.**

```bash
# Path: terminal
pnpm tsc --noEmit
```

**Key implementation notes:**
- Do not start broad surface rollout inside Phase 2; it creates merge conflicts with Phase 4 owners.
- Use `MemberIdentity` for destructive dialogs when it reduces ambiguity.
- Exports stay text-only and do not import these UI components.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/team-member-avatars/phases/phase2.md` | Reference | Component usage contract for later agents. |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `app/workspace/_components/member-avatar.tsx` | Create / Modify | 2A, 2B, 2D |
| `app/workspace/_components/member-identity.tsx` | Create / Modify | 2C, 2D |
| `components/ui/avatar.tsx` | Verify | 2D |
| `plans/team-member-avatars/phases/phase2.md` | Reference | 2E |
