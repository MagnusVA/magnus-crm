# Phase 3 — Tenant Onboarding: Invite Validation, Signup & Onboarding UI

**Goal:** A tenant master clicks an invite URL, the system validates the token, redirects them to WorkOS AuthKit org-scoped signup, and after authentication they land on an onboarding page prompting them to connect Calendly.

**Prerequisite:** Phase 2 complete (tenant records exist with invite tokens, WorkOS orgs created).

**Acceptance Criteria:**
1. Visiting `/onboarding?token=VALID_TOKEN` shows a loading state, validates the token, and redirects to WorkOS AuthKit signup scoped to the correct organization.
2. Visiting `/onboarding?token=EXPIRED_TOKEN` shows a clear "invite expired" error page.
3. Visiting `/onboarding?token=ALREADY_USED_TOKEN` shows a "already redeemed" error page.
4. Visiting `/onboarding?token=GARBAGE` shows a "invalid invite" error page.
5. After completing WorkOS signup and being redirected back, the user lands on `/onboarding/connect` showing the company name and a "Connect Calendly" button.
6. The tenant record is updated to `status: "pending_calendly"` and a `users` record exists with `role: "tenant_master"`.
7. The system admin dashboard at `/admin` shows all tenants with their current status.

---

## Subphases

### 3A — Invite Validation Backend (`convex/onboarding/invite.ts`)

**Type:** Backend
**Parallelizable:** Yes — no frontend dependency.

**What:** Convex functions to validate invite tokens and redeem them (mark as used, create user record, transition tenant status).

**Where:** `convex/onboarding/invite.ts`

**How:**

This file needs `"use node"` because `validateInviteToken` and `hashInviteToken` use Node.js `crypto`.

```typescript
// convex/onboarding/invite.ts
"use node";

import { v } from "convex/values";
import { action } from "../_generated/server";
import { internal } from "../_generated/api";
import { validateInviteToken, hashInviteToken } from "../lib/inviteToken";

/**
 * Validate an invite token. Returns tenant info if valid, or an error status.
 * Called by the frontend when the user lands on /onboarding?token=...
 *
 * This is an action (not query) because it uses Node.js crypto.
 */
export const validateInvite = action({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const signingSecret = process.env.INVITE_SIGNING_SECRET!;

    // Step 1: Validate HMAC signature
    const payload = validateInviteToken(token, signingSecret);
    if (!payload) {
      return { valid: false, error: "invalid_signature" as const };
    }

    // Step 2: Look up tenant by token hash
    const tokenHash = hashInviteToken(token);
    const tenant = await ctx.runQuery(internal.tenants.getByInviteTokenHash, {
      inviteTokenHash: tokenHash,
    });

    if (!tenant) {
      return { valid: false, error: "not_found" as const };
    }

    // Step 3: Check if already redeemed
    if (tenant.inviteRedeemedAt !== undefined) {
      return { valid: false, error: "already_redeemed" as const };
    }

    // Step 4: Check expiry
    if (Date.now() > tenant.inviteExpiresAt) {
      return { valid: false, error: "expired" as const };
    }

    return {
      valid: true,
      tenantId: tenant._id,
      companyName: tenant.companyName,
      workosOrgId: tenant.workosOrgId,
      contactEmail: tenant.contactEmail,
    };
  },
});
```

**Files touched:** `convex/onboarding/invite.ts`

---

### 3B — Invite Redemption Backend (`convex/onboarding/complete.ts`)

**Type:** Backend
**Parallelizable:** Yes — can be built alongside 3A.

**What:** A mutation that marks the invite as redeemed, creates the user record, and transitions tenant status to `pending_calendly`. Called after the user completes WorkOS signup and authenticates.

**Where:** `convex/onboarding/complete.ts`

**How:**

This file does NOT need `"use node"` — it's a mutation that receives pre-computed data.

```typescript
// convex/onboarding/complete.ts
import { v } from "convex/values";
import { mutation } from "../_generated/server";

/**
 * Called after the tenant master completes WorkOS signup.
 * Marks the invite as redeemed and creates the user record.
 *
 * The frontend calls this after AuthKit login, passing the workosOrgId
 * from the JWT. The mutation resolves the tenant from the org ID.
 */
export const redeemInviteAndCreateUser = mutation({
  args: {
    workosOrgId: v.string(),
  },
  handler: async (ctx, { workosOrgId }) => {
    // Auth required — the user just signed up via AuthKit
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    // Find tenant by WorkOS org ID
    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_workosOrgId", (q) => q.eq("workosOrgId", workosOrgId))
      .unique();

    if (!tenant) throw new Error("No tenant found for this organization");

    // Only redeem if still pending signup
    if (tenant.status !== "pending_signup") {
      // Already redeemed — return existing tenant info
      return { tenantId: tenant._id, alreadyRedeemed: true };
    }

    // Mark invite as redeemed
    await ctx.db.patch(tenant._id, {
      inviteRedeemedAt: Date.now(),
      status: "pending_calendly" as const,
    });

    // Create user record
    const existingUser = await ctx.db
      .query("users")
      .withIndex("by_workosUserId", (q) =>
        q.eq("workosUserId", identity.subject),
      )
      .unique();

    if (!existingUser) {
      await ctx.db.insert("users", {
        tenantId: tenant._id,
        workosUserId: identity.subject,
        email: identity.email ?? "",
        fullName: identity.name ?? undefined,
        role: "tenant_master" as const,
      });
    }

    return { tenantId: tenant._id, alreadyRedeemed: false };
  },
});
```

**Key design decision:** We resolve the tenant from `workosOrgId` in the JWT (via `identity`), not from a client-provided `tenantId`. This prevents spoofing. The WorkOS org ID in the JWT is authoritative.

**Files touched:** `convex/onboarding/complete.ts`

---

### 3C — Onboarding Page: Token Validation (`app/onboarding/page.tsx`)

**Type:** Frontend (UI/UX)
**Parallelizable:** Depends on 3A for the backend function.

**What:** A Next.js page at `/onboarding` that reads the `token` query parameter, validates it via the Convex action, and either redirects to WorkOS signup or shows an error.

**Where:** `app/onboarding/page.tsx`

**Design guidelines:**
- **Vercel React best practices:** This is a client component because it needs `useAction` from Convex and interacts with `window.location` for the redirect.
- **Composition pattern:** Separate the validation logic from the presentation. Use a `<InviteGate>` wrapper that handles the async validation state, and render different children based on the result.
- **Web design guidelines:** Error states must be clear and actionable — tell the user what happened and what to do next. Use shadcn `Card`, `Alert`, and `Button` components for consistency.

**How:**

```
app/
└── onboarding/
    ├── page.tsx              # Token validation + redirect to AuthKit signup
    └── connect/
        └── page.tsx          # Post-signup: "Connect Calendly" UI (subphase 3D)
```

The page should:

1. Read `token` from `searchParams`.
2. Call `api.onboarding.invite.validateInvite({ token })` via `useAction`.
3. Show a loading spinner while validating.
4. On success: store `workosOrgId` and `companyName` in sessionStorage, then redirect to the WorkOS AuthKit signup URL scoped to that org: `/sign-up?organization_id={workosOrgId}`.
5. On error: render an `Alert` component with the appropriate message.

**Example component structure:**

```tsx
"use client";

import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import Link from "next/link";

type ValidationState =
  | { status: "loading" }
  | { status: "valid"; companyName: string; workosOrgId: string }
  | { status: "error"; error: string };

export default function OnboardingPage() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const validateInvite = useAction(api.onboarding.invite.validateInvite);
  const [state, setState] = useState<ValidationState>({ status: "loading" });

  useEffect(() => {
    if (!token) {
      setState({ status: "error", error: "no_token" });
      return;
    }
    validateInvite({ token }).then((result) => {
      if (result.valid) {
        // Store for post-signup flow
        sessionStorage.setItem("onboarding_orgId", result.workosOrgId);
        sessionStorage.setItem("onboarding_companyName", result.companyName);
        sessionStorage.setItem("onboarding_tenantId", result.tenantId);
        // Redirect to org-scoped signup
        window.location.href = `/sign-up?organization_id=${result.workosOrgId}`;
      } else {
        setState({ status: "error", error: result.error });
      }
    });
  }, [token, validateInvite]);

  // Render based on state — loading spinner, or error Alert
  // ...
}
```

**Error message mapping:**

| Error code | User-facing message |
|---|---|
| `no_token` | "No invite token provided. Please use the link sent to you by your administrator." |
| `invalid_signature` | "This invite link is invalid. Please contact your administrator for a new link." |
| `not_found` | "This invite link is not recognized. Please contact your administrator." |
| `already_redeemed` | "This invite has already been used. If you need to sign in, go to the login page." |
| `expired` | "This invite link has expired. Please contact your administrator for a new one." |

**Files touched:** `app/onboarding/page.tsx` (create)

---

### 3D — Post-Signup: Connect Calendly Page (`app/onboarding/connect/page.tsx`)

**Type:** Frontend (UI/UX)
**Parallelizable:** Can be built alongside 3C.

**What:** After the user completes WorkOS signup and is redirected back to the app, they land on this page. It shows the company name, a welcome message, and a prominent "Connect your Calendly account" button.

**Where:** `app/onboarding/connect/page.tsx`

**Design guidelines:**
- **Vercel React best practices:** Client component — needs `useAuth` for session state and `useMutation` for the redeem call.
- **Composition pattern:** Use a `<OnboardingShell>` layout component wrapping a content card. The shell handles auth checks and loading states; the inner content is the Calendly CTA.
- **Web design guidelines:**
  - Full-page centered card layout (max-width 480px).
  - Company logo placeholder (use first letter of company name in an `Avatar`).
  - Clear heading: "Welcome to {companyName}".
  - Brief explanation: what connecting Calendly does and what permissions are needed.
  - Single primary CTA button: "Connect Calendly".
  - Subdued secondary text explaining that Calendly access is required to proceed.

**How:**

This page must:
1. Check if the user is authenticated (via `useConvexAuth`). If not, redirect to sign-in.
2. On first render (after signup redirect), call `redeemInviteAndCreateUser` with the `workosOrgId` from the JWT or sessionStorage.
3. Show the "Connect Calendly" button which triggers the OAuth flow (built in Phase 4).

```tsx
"use client";

import { Authenticated, useConvexAuth, useMutation } from "convex/react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { api } from "@/convex/_generated/api";
import { useEffect, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Spinner } from "@/components/ui/spinner";

export default function ConnectCalendlyPage() {
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth();
  const { user } = useAuth();

  if (authLoading) {
    return <OnboardingShell><Spinner /></OnboardingShell>;
  }

  if (!isAuthenticated) {
    // redirect to sign-in (or show a link)
    return null;
  }

  return (
    <Authenticated>
      <OnboardingContent />
    </Authenticated>
  );
}

function OnboardingShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-1 flex-col items-center justify-center bg-muted/40 px-4 py-12">
      <div className="w-full max-w-md">
        {children}
      </div>
    </div>
  );
}

function OnboardingContent() {
  const redeemInvite = useMutation(api.onboarding.complete.redeemInviteAndCreateUser);
  const [redeemed, setRedeemed] = useState(false);
  const companyName = typeof window !== "undefined"
    ? sessionStorage.getItem("onboarding_companyName") ?? "Your Company"
    : "Your Company";

  useEffect(() => {
    const orgId = sessionStorage.getItem("onboarding_orgId");
    if (orgId && !redeemed) {
      redeemInvite({ workosOrgId: orgId }).then(() => {
        setRedeemed(true);
        sessionStorage.removeItem("onboarding_orgId");
        sessionStorage.removeItem("onboarding_companyName");
        sessionStorage.removeItem("onboarding_tenantId");
      });
    }
  }, [redeemInvite, redeemed]);

  const initial = companyName.charAt(0).toUpperCase();

  return (
    <OnboardingShell>
      <Card className="shadow-sm">
        <CardHeader className="items-center text-center">
          <Avatar className="mb-4 size-16">
            <AvatarFallback className="text-2xl">{initial}</AvatarFallback>
          </Avatar>
          <CardTitle className="text-xl">Welcome to {companyName}</CardTitle>
          <CardDescription>
            Connect your Calendly account to start receiving meeting data
            in your CRM dashboard.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
            <p className="font-medium text-foreground mb-1">What we need access to:</p>
            <ul className="list-disc pl-4 space-y-1">
              <li>Read your scheduled events and invitees</li>
              <li>Read your event type configurations</li>
              <li>Create webhook subscriptions for real-time updates</li>
            </ul>
          </div>
          <Button
            size="lg"
            className="w-full"
            onClick={() => {
              // Phase 4 will implement this — calls Convex action to get
              // the Calendly OAuth authorize URL and redirects
              console.log("TODO: trigger Calendly OAuth flow");
            }}
          >
            Connect Calendly
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            Calendly access is required to complete setup.
          </p>
        </CardContent>
      </Card>
    </OnboardingShell>
  );
}
```

**Note:** The "Connect Calendly" button is a placeholder in this phase. Phase 4 will wire it to the OAuth flow.

**Files touched:** `app/onboarding/connect/page.tsx` (create)

---

### 3E — System Admin Dashboard Page (`app/admin/page.tsx`)

**Type:** Frontend (UI/UX)
**Parallelizable:** Yes — independent of 3C and 3D.

**What:** A simple admin page that lists all tenants with their status and provides a "Create New Tenant" form.

**Where:** `app/admin/page.tsx`

**Design guidelines:**
- **Vercel React best practices:** Client component — uses `useQuery` and `useAction` from Convex.
- **Composition pattern:** Separate the tenant list (`<TenantList>`) from the create form (`<CreateTenantForm>`). Each is an independent component that can re-render independently.
- **Web design guidelines:**
  - Full-width layout with a `max-w-4xl` container.
  - Use shadcn `Table` for the tenant list (columns: Company, Email, Status, Created, Actions).
  - Use shadcn `Dialog` for the create form (modal on button click).
  - Status badges using shadcn `Badge` with color coding:
    - `pending_signup` → yellow/warning
    - `pending_calendly` → blue/info
    - `active` → green/success
    - `calendly_disconnected` → red/destructive
    - `suspended` → gray/muted
  - "Copy invite link" button in the actions column for pending tenants.

**How:**

```
app/
└── admin/
    ├── page.tsx           # Admin dashboard page
    └── layout.tsx         # Optional: admin-specific layout with nav
```

The page should:
1. Verify the user is authenticated and belongs to the system admin org.
2. Use `useQuery(api.admin.tenantsQueries.listTenants)` to fetch all tenants.
3. Use `useAction(api.admin.tenants.createTenantInvite)` for the create form.
4. Display results in a table with status badges.
5. Show a dialog for creating a new tenant with fields: Company Name, Contact Email, Notes (optional).
6. After successful creation, display the invite URL with a copy-to-clipboard button.

**Files touched:** `app/admin/page.tsx` (create), optionally `app/admin/layout.tsx`

---

### 3F — App Router Guards & Redirect Logic

**Type:** Frontend
**Parallelizable:** Yes — can be done alongside other frontend work.

**What:** Update the app's routing to handle the post-signup redirect. After WorkOS AuthKit signup, the user is redirected to the app's callback URL. We need to detect that this is an onboarding flow and redirect to `/onboarding/connect` instead of the default home page.

**Where:** `app/callback/route.ts`, potentially `proxy.ts` or middleware

**How:**

The current callback route uses `handleAuth()` from `@workos-inc/authkit-nextjs`. After successful auth, it redirects to the homepage by default. We need it to redirect to `/onboarding/connect` when the user is in an onboarding flow.

**Strategy:** Use a `returnTo` cookie or query parameter:
1. In `app/onboarding/page.tsx` (3C), before redirecting to AuthKit signup, set a cookie: `onboarding_return=/onboarding/connect`.
2. The callback route reads this cookie and redirects there instead of `/`.

Alternatively, the `getSignUpUrl` from `@workos-inc/authkit-nextjs` supports a `returnPathname` option. Check the SDK docs (see `.agents/skills/workos/references/workos-authkit-nextjs.md`).

```typescript
// app/sign-up/route.ts — may need modification
import { getSignUpUrl } from "@workos-inc/authkit-nextjs";
import { NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  const organizationId = request.nextUrl.searchParams.get("organization_id");
  const signUpUrl = await getSignUpUrl({
    organizationId: organizationId ?? undefined,
    returnPathname: "/onboarding/connect",
  });
  return Response.redirect(signUpUrl);
}
```

**Files touched:** `app/sign-up/route.ts` (modify), `app/callback/route.ts` (possibly modify)

---

### 3G — Cleanup: Remove Todo Placeholder UI

**Type:** Frontend
**Parallelizable:** Yes — can be done first.

**What:** Replace the todo app on `app/page.tsx` with a simple redirect or landing page. The home page should redirect authenticated users to either `/admin` (system admin) or `/onboarding/connect` (tenant master in onboarding) or the main dashboard (active tenant users — not built yet, just show a placeholder).

**Where:** `app/page.tsx`

**How:**

Replace the entire todo UI with a role-based redirect:

```tsx
"use client";

import { useConvexAuth } from "convex/react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Spinner } from "@/components/ui/spinner";
import { SYSTEM_ADMIN_ORG_ID } from "@/lib/system-admin-org";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function Home() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { user } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (isLoading || !isAuthenticated || !user) return;

    // Check if system admin (org ID in the user's org memberships)
    // For now, simple redirect logic:
    // System admins go to /admin, everyone else sees a placeholder
  }, [isLoading, isAuthenticated, user, router]);

  if (isLoading) {
    return (
      <div className="flex min-h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-4">
        <h1 className="text-2xl font-bold">PTDOM CRM</h1>
        <Button asChild>
          <Link href="/sign-in">Sign in</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-4">
      <h1 className="text-2xl font-bold">PTDOM CRM</h1>
      <p className="text-muted-foreground">Dashboard coming soon.</p>
      <Button asChild variant="outline">
        <Link href="/admin">Admin Panel</Link>
      </Button>
    </div>
  );
}
```

**Files touched:** `app/page.tsx` (rewrite)

---

## Parallelization Summary

```
3A (validate backend) ───────┐
3B (redeem backend) ─────────┤
                             ├── 3C (onboarding page) ──┐
                             │                           ├── 3F (routing guards)
                             │                           │
3D (connect page) ───────────┘───────────────────────────┘
3E (admin dashboard) ────────────────────────────────────
3G (cleanup todos) ──────────────────────────────────────
```

3A, 3B, 3D, 3E, 3G can all start immediately. 3C needs 3A's backend function. 3F needs 3C and 3D to understand the routing flow.

---

## Files Modified/Created Summary

| File | Action | Subphase |
|---|---|---|
| `convex/onboarding/invite.ts` | Implemented | 3A |
| `convex/onboarding/complete.ts` | Implemented | 3B |
| `app/onboarding/page.tsx` | Created | 3C |
| `app/onboarding/connect/page.tsx` | Created | 3D |
| `app/admin/page.tsx` | Created | 3E |
| `app/sign-up/route.ts` | Modified | 3F |
| `app/page.tsx` | Rewritten | 3G |
