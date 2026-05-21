# Phase 3 — Public DM Link Portal

**Goal:** Build the WorkOS-unprotected `/dm-links/[portalSlug]` route that accepts a tenant portal password, stores a short-lived HttpOnly session cookie, loads a minimal tenant-scoped bootstrap payload, and lets external DM closers copy canonical Calendly links.

**Prerequisite:** Phase 2A-2E are complete, `LINK_PORTAL_SESSION_SECRET` is configured in Convex, and `LINK_PORTAL_IP_HASH_SECRET` is configured for the Next.js runtime. Read the Next.js 16 docs for async `params`, `cookies()`, `headers()`, Server Actions, and `proxy.ts`; read `.docs/convex/nextjs.md` and `.docs/convex/module-nextjs.md` before implementing `fetchAction`.

**Runs in PARALLEL with:** Phase 4 after Phase 2 API contracts are stable. Phase 5 can start after the copy UI exposes a single copy handler.

**Skills to invoke:**
- `next-best-practices` — Dynamic route params, async cookies/headers, Server Actions, and proxy conventions.
- `frontend-design` — The portal is a dense working tool for DM closers, not a landing page.
- `shadcn` — Use existing `Button`, `Input`, `Select`, `Card`, `Alert`, `Badge`, `Skeleton`, and `Tooltip` primitives.
- `web-design-guidelines` — Verify keyboard, screen reader, and mobile behavior before shipping.

**Acceptance Criteria:**
1. `/dm-links/[portalSlug]` is publicly reachable without a WorkOS session.
2. Before password verification, the page does not reveal tenant name, teams, DM closers, programs, campaigns, or whether the slug exists.
3. Submitting the correct portal password sets an HttpOnly, `SameSite=Lax`, slug-scoped cookie under `/dm-links/{portalSlug}`.
4. Expired, invalid, disabled, or wrong-version portal sessions show the password screen and do not expose bootstrap data.
5. Authenticated portal bootstrap returns only active DM closers with active teams, active campaign presets, and portal-enabled ready event types.
6. Generated URLs overwrite `utm_source`, `utm_medium`, and `utm_campaign` while preserving non-UTM query params already present on `bookingBaseUrl`.
7. The portal lets the operator select DM closer, bookable program/event type, and campaign, then copy the generated link.
8. Clipboard failure leaves the generated URL visible and selectable for manual copy.
9. `npx convex dev --once` passes without schema or function registration errors.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
3A (public proxy + route shell) ─────┬── 3B (unlock/logout server actions)
                                    └── 3C (portal bootstrap action)

3B + 3C complete ────────────────────→ 3D (portal client UI)

3D complete ─────────────────────────┬── 3E (URL builder + copy fallback)
                                    └── 3F (responsive/accessibility verification)
```

**Optimal execution:**
1. Add `/dm-links` to `proxy.ts` and create the route shell.
2. Implement Server Actions and Convex bootstrap action against the Phase 2 session token helper.
3. Build the client selector and URL builder.
4. Verify public-route behavior in a browser with and without the portal cookie.

**Estimated time:** 3-4 days

---

## Subphases

### 3A — Public Route and Proxy Bypass

**Type:** Full-Stack  
**Parallelizable:** Yes — can run alongside Convex bootstrap work once Phase 2 exists.

**What:** Add `/dm-links` to `PUBLIC_PREFIXES`, create the dynamic route, read the portal session cookie, and pass bootstrap data or `null` to a client component.

**Why:** The external portal must bypass WorkOS while keeping `/workspace` protected by the existing layout and Convex auth checks.

**Where:**
- `proxy.ts` (modify)
- `app/dm-links/[portalSlug]/page.tsx` (create)
- `app/dm-links/[portalSlug]/loading.tsx` (create)
- `app/dm-links/[portalSlug]/_components/dm-link-portal-client.tsx` (create)

**How:**

**Step 1: Add `/dm-links` to public prefixes.**

```typescript
// Path: proxy.ts
const PUBLIC_PREFIXES = [
  "/sign-in",
  "/sign-up",
  "/callback",
  "/onboarding",
  "/privacy",
  "/support",
  "/dm-links",
] as const;
```

**Step 2: Create the route page with async params and cookies.**

```tsx
// Path: app/dm-links/[portalSlug]/page.tsx
import { cookies } from "next/headers";
import { fetchAction } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { DmLinkPortalClient } from "./_components/dm-link-portal-client";
import { logoutPortal, unlockPortal } from "./actions";

export const unstable_instant = false;

type Props = {
  params: Promise<{ portalSlug: string }>;
};

export default async function DmLinksPage({ params }: Props) {
  const { portalSlug } = await params;
  const cookieStore = await cookies();
  const cookieName = `dm_link_portal_${portalSlug}`;
  const sessionToken = cookieStore.get(cookieName)?.value;

  const bootstrap = sessionToken
    ? await fetchAction(api.linkPortal.portalActions.getPortalBootstrap, {
        portalSlug,
        sessionToken,
      }).catch(() => null)
    : null;

  return (
    <DmLinkPortalClient
      portalSlug={portalSlug}
      bootstrap={bootstrap}
      unlockPortal={unlockPortal}
      logoutPortal={logoutPortal}
    />
  );
}
```

**Step 3: Add a loading fallback with stable dimensions.**

```tsx
// Path: app/dm-links/[portalSlug]/loading.tsx
import { Skeleton } from "@/components/ui/skeleton";

export default function DmLinksLoading() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-4 p-4 md:p-8">
      <Skeleton className="h-10 w-64" />
      <Skeleton className="h-96 w-full" />
    </main>
  );
}
```

**Key implementation notes:**
- Do not call WorkOS `withAuth()` or `requireRole()` anywhere under `/dm-links`.
- `params` and `cookies()` are async in Next.js 16.
- The route can call `fetchAction` without a WorkOS token because portal actions validate their own signed session token.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `proxy.ts` | Modify | Public route bypass |
| `app/dm-links/[portalSlug]/page.tsx` | Create | Public RSC route |
| `app/dm-links/[portalSlug]/loading.tsx` | Create | Route loading UI |
| `app/dm-links/[portalSlug]/_components/dm-link-portal-client.tsx` | Create | Client boundary |

---

### 3B — Unlock and Logout Server Actions

**Type:** Full-Stack  
**Parallelizable:** Yes — depends on Phase 2 password action but not on final client UI.

**What:** Add Server Actions for password submission, IP hashing, cookie setting, and logout.

**Why:** The session token must never be stored in localStorage or React state. Next.js Server Actions can verify the password server-side and set an HttpOnly cookie.

**Where:**
- `app/dm-links/[portalSlug]/actions.ts` (create)

**How:**

**Step 1: Add requester IP hashing.**

```typescript
// Path: app/dm-links/[portalSlug]/actions.ts
"use server";

import { createHmac } from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { fetchAction } from "convex/nextjs";
import { api } from "@/convex/_generated/api";

function ipHashSecret() {
  const secret = process.env.LINK_PORTAL_IP_HASH_SECRET;
  if (!secret) {
    throw new Error("LINK_PORTAL_IP_HASH_SECRET is not configured.");
  }
  return secret;
}

async function hashRequesterIp() {
  const headerStore = await headers();
  const forwardedFor = headerStore.get("x-forwarded-for")?.split(",")[0]?.trim();
  const realIp = headerStore.get("x-real-ip");
  const ip = forwardedFor || realIp || "unknown";
  return createHmac("sha256", ipHashSecret()).update(ip).digest("base64url");
}
```

**Step 2: Verify password and set the cookie.**

```typescript
// Path: app/dm-links/[portalSlug]/actions.ts
export async function unlockPortal(portalSlug: string, formData: FormData) {
  const password = String(formData.get("password") ?? "");
  const ipHash = await hashRequesterIp();

  const result = await fetchAction(api.linkPortal.passwordActions.verifyPassword, {
    portalSlug,
    password,
    ipHash,
  });

  const cookieStore = await cookies();
  cookieStore.set(`dm_link_portal_${portalSlug}`, result.sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: `/dm-links/${portalSlug}`,
    maxAge: result.maxAgeSeconds,
  });

  redirect(`/dm-links/${portalSlug}`);
}
```

**Step 3: Add logout.**

```typescript
// Path: app/dm-links/[portalSlug]/actions.ts
export async function logoutPortal(portalSlug: string) {
  const cookieStore = await cookies();
  cookieStore.delete(`dm_link_portal_${portalSlug}`);
  redirect(`/dm-links/${portalSlug}`);
}
```

**Key implementation notes:**
- Treat Server Actions as public POST endpoints; Convex verification is the auth check.
- Keep `redirect()` outside `try/catch` blocks.
- The cookie path must include the slug so a token for one portal cannot be sent to another route.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/dm-links/[portalSlug]/actions.ts` | Create | Unlock/logout Server Actions |

---

### 3C — Portal Bootstrap Action

**Type:** Backend  
**Parallelizable:** Yes — depends on Phase 2 session token helper and schema.

**What:** Validate a portal session token and return the minimal portal bootstrap payload.

**Why:** The public route should reveal tenant data only after password verification and only for active, portal-ready rows.

**Where:**
- `convex/linkPortal/portalActions.ts` (create)
- `convex/linkPortal/portalQueries.ts` (create)

**How:**

**Step 1: Add internal bootstrap query.**

```typescript
// Path: convex/linkPortal/portalQueries.ts
import { v } from "convex/values";
import { internalQuery } from "../_generated/server";

export const getPortalBootstrapForSession = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    publicSlug: v.string(),
    sessionVersion: v.number(),
  },
  handler: async (ctx, { tenantId, publicSlug, sessionVersion }) => {
    const config = await ctx.db
      .query("linkPortalConfigs")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .unique();
    if (
      !config ||
      !config.isEnabled ||
      config.publicSlug !== publicSlug ||
      config.sessionVersion !== sessionVersion
    ) {
      throw new Error("Portal session is no longer valid.");
    }

    const tenant = await ctx.db.get(tenantId);
    const [teams, closers, campaigns, eventTypeConfigs] = await Promise.all([
      ctx.db
        .query("attributionTeams")
        .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
        .take(200),
      ctx.db
        .query("dmClosers")
        .withIndex("by_tenantId_and_teamId", (q) => q.eq("tenantId", tenantId))
        .take(300),
      ctx.db
        .query("linkPortalCampaignPresets")
        .withIndex("by_tenantId_and_isActive", (q) =>
          q.eq("tenantId", tenantId).eq("isActive", true),
        )
        .take(100),
      ctx.db
        .query("eventTypeConfigs")
        .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
        .take(100),
    ]);

    const activeTeamById = new Map(
      teams.filter((team) => team.isActive).map((team) => [team._id, team]),
    );

    return {
      tenantName: tenant?.companyName ?? "Workspace",
      campaignPresets: campaigns
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((campaign) => ({
          id: campaign._id,
          label: campaign.label,
          utmCampaign: campaign.utmCampaign,
          isDefault: campaign.isDefault,
        })),
      dmClosers: closers
        .filter((closer) => closer.isActive && activeTeamById.has(closer.teamId))
        .map((closer) => {
          const team = activeTeamById.get(closer.teamId)!;
          return {
            id: closer._id,
            displayName: closer.displayName,
            utmMedium: closer.utmMedium,
            teamId: team._id,
            teamDisplayName: team.displayName,
            teamUtmSource: team.utmSource,
          };
        }),
      bookablePrograms: eventTypeConfigs
        .filter(
          (config) =>
            config.linkPortalEnabled === true &&
            config.bookingBaseUrl &&
            config.bookingProgramId &&
            config.bookingProgramMappingStatus === "mapped",
        )
        .map((config) => ({
          eventTypeConfigId: config._id,
          eventTypeDisplayName: config.displayName,
          bookingProgramId: config.bookingProgramId!,
          bookingProgramName: config.bookingProgramName ?? config.displayName,
          bookingBaseUrl: config.bookingBaseUrl!,
        })),
    };
  },
});
```

**Step 2: Add public action that validates the token.**

```typescript
// Path: convex/linkPortal/portalActions.ts
"use node";

import { v } from "convex/values";
import { action } from "../_generated/server";
import { internal } from "../_generated/api";
import { verifyPortalSessionToken } from "./sessionToken";

export const getPortalBootstrap = action({
  args: {
    portalSlug: v.string(),
    sessionToken: v.string(),
  },
  handler: async (ctx, { portalSlug, sessionToken }) => {
    const session = verifyPortalSessionToken(sessionToken);
    if (session.publicSlug !== portalSlug) {
      throw new Error("Portal session is no longer valid.");
    }

    return await ctx.runQuery(
      internal.linkPortal.portalQueries.getPortalBootstrapForSession,
      {
        tenantId: session.tenantId,
        publicSlug: portalSlug,
        sessionVersion: session.sessionVersion,
      },
    );
  },
});
```

**Key implementation notes:**
- Do not return WorkOS org IDs, tenant IDs, emails, payment links, raw webhook data, or raw unmapped UTM rows.
- Internal IDs in the bootstrap are acceptable for later copy audit validation, but no ID should be trusted without reloading in Convex.
- If the current config session version differs from the token, reject the session.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/linkPortal/portalQueries.ts` | Create | Tenant-scoped bootstrap read |
| `convex/linkPortal/portalActions.ts` | Create | Public session validation action |

---

### 3D — Portal Client UI

**Type:** Frontend  
**Parallelizable:** No — depends on route shell and bootstrap payload shape.

**What:** Build the password form, authenticated selector tool, generated URL field, copy action, and logout action.

**Why:** External DM closers need an efficient link-building tool without CRM navigation or marketing copy.

**Where:**
- `app/dm-links/[portalSlug]/_components/dm-link-portal-client.tsx` (modify)

**How:**

**Step 1: Define serializable props and local selection state.**

```tsx
// Path: app/dm-links/[portalSlug]/_components/dm-link-portal-client.tsx
"use client";

import { useMemo, useState, useTransition } from "react";
import { CopyIcon, LogOutIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { buildBookingUrl } from "./build-booking-url";

type PortalBootstrap = {
  tenantName: string;
  campaignPresets: Array<{ id: string; label: string; utmCampaign: string; isDefault: boolean }>;
  dmClosers: Array<{
    id: string;
    displayName: string;
    utmMedium: string;
    teamDisplayName: string;
    teamUtmSource: string;
  }>;
  bookablePrograms: Array<{
    eventTypeConfigId: string;
    eventTypeDisplayName: string;
    bookingProgramName: string;
    bookingBaseUrl: string;
  }>;
};
```

**Step 2: Render a neutral password screen when locked.**

```tsx
// Path: app/dm-links/[portalSlug]/_components/dm-link-portal-client.tsx
function PasswordScreen({
  portalSlug,
  unlockPortal,
}: {
  portalSlug: string;
  unlockPortal: (portalSlug: string, formData: FormData) => Promise<void>;
}) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md items-center p-4">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>DM link portal</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={unlockPortal.bind(null, portalSlug)} className="flex flex-col gap-3">
            <Input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              placeholder="Portal password"
            />
            <Button type="submit">Unlock</Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
```

**Step 3: Render the authenticated tool.**

```tsx
// Path: app/dm-links/[portalSlug]/_components/dm-link-portal-client.tsx
export function DmLinkPortalClient(props: {
  portalSlug: string;
  bootstrap: PortalBootstrap | null;
  unlockPortal: (portalSlug: string, formData: FormData) => Promise<void>;
  logoutPortal: (portalSlug: string) => Promise<void>;
}) {
  const [selectedCloserId, setSelectedCloserId] = useState(
    props.bootstrap?.dmClosers[0]?.id ?? "",
  );
  const [selectedProgramId, setSelectedProgramId] = useState(
    props.bootstrap?.bookablePrograms[0]?.eventTypeConfigId ?? "",
  );
  const [selectedCampaignId, setSelectedCampaignId] = useState(
    props.bootstrap?.campaignPresets.find((campaign) => campaign.isDefault)?.id ??
      props.bootstrap?.campaignPresets[0]?.id ??
      "",
  );

  if (!props.bootstrap) {
    return <PasswordScreen portalSlug={props.portalSlug} unlockPortal={props.unlockPortal} />;
  }

  const closer = props.bootstrap.dmClosers.find((row) => row.id === selectedCloserId);
  const program = props.bootstrap.bookablePrograms.find(
    (row) => row.eventTypeConfigId === selectedProgramId,
  );
  const campaign = props.bootstrap.campaignPresets.find(
    (row) => row.id === selectedCampaignId,
  );

  const generatedUrl =
    closer && program && campaign
      ? buildBookingUrl({
          bookingBaseUrl: program.bookingBaseUrl,
          teamUtmSource: closer.teamUtmSource,
          closerUtmMedium: closer.utmMedium,
          campaign: campaign.utmCampaign,
        })
      : "";

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-4 p-4 md:p-8">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{props.bootstrap.tenantName}</h1>
        <form action={props.logoutPortal.bind(null, props.portalSlug)}>
          <Button type="submit" variant="ghost" size="icon" aria-label="Log out">
            <LogOutIcon />
          </Button>
        </form>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Booking link</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Input value={generatedUrl} readOnly />
        </CardContent>
      </Card>
    </main>
  );
}
```

**Key implementation notes:**
- Keep the first authenticated screen as the tool itself.
- Use icon-only buttons only when the icon is familiar and `aria-label` is present.
- Do not include feature-explainer copy in the app surface.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/dm-links/[portalSlug]/_components/dm-link-portal-client.tsx` | Modify | Password and authenticated portal UI |

---

### 3E — URL Builder and Copy Fallback

**Type:** Frontend  
**Parallelizable:** Yes — depends on final bootstrap shape.

**What:** Add a pure URL builder and copy helper that overwrites canonical UTM params and preserves existing non-UTM params.

**Why:** Link generation should be deterministic, testable, and independent from React state.

**Where:**
- `app/dm-links/[portalSlug]/_components/build-booking-url.ts` (create)
- `app/dm-links/[portalSlug]/_components/dm-link-portal-client.tsx` (modify)

**How:**

**Step 1: Add a pure URL builder.**

```typescript
// Path: app/dm-links/[portalSlug]/_components/build-booking-url.ts
type BuildBookingUrlInput = {
  bookingBaseUrl: string;
  teamUtmSource: string;
  closerUtmMedium: string;
  campaign: string;
};

export function buildBookingUrl(input: BuildBookingUrlInput) {
  const url = new URL(input.bookingBaseUrl);
  url.searchParams.set("utm_source", input.teamUtmSource);
  url.searchParams.set("utm_medium", input.closerUtmMedium);
  url.searchParams.set("utm_campaign", input.campaign);
  return url.toString();
}
```

**Step 2: Add copy behavior with manual fallback.**

```tsx
// Path: app/dm-links/[portalSlug]/_components/dm-link-portal-client.tsx
const [copyState, setCopyState] = useState<"idle" | "copied" | "manual">("idle");
const [isPending, startTransition] = useTransition();

function copyGeneratedUrl(value: string) {
  startTransition(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopyState("copied");
    } catch {
      setCopyState("manual");
    }
  });
}
```

**Step 3: Render generated URL controls.**

```tsx
// Path: app/dm-links/[portalSlug]/_components/dm-link-portal-client.tsx
<Card>
  <CardHeader>
    <CardTitle>Booking link</CardTitle>
  </CardHeader>
  <CardContent className="flex flex-col gap-4">
    <div className="grid gap-3 md:grid-cols-3">
      <Select value={selectedCloserId} onValueChange={setSelectedCloserId}>
        <SelectTrigger><SelectValue placeholder="DM closer" /></SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {props.bootstrap.dmClosers.map((closer) => (
              <SelectItem key={closer.id} value={closer.id}>
                {closer.displayName}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <Select value={selectedProgramId} onValueChange={setSelectedProgramId}>
        <SelectTrigger><SelectValue placeholder="Program" /></SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {props.bootstrap.bookablePrograms.map((program) => (
              <SelectItem key={program.eventTypeConfigId} value={program.eventTypeConfigId}>
                {program.bookingProgramName}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <Select value={selectedCampaignId} onValueChange={setSelectedCampaignId}>
        <SelectTrigger><SelectValue placeholder="Campaign" /></SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {props.bootstrap.campaignPresets.map((campaign) => (
              <SelectItem key={campaign.id} value={campaign.id}>
                {campaign.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
    <div className="flex gap-2">
      <Input value={generatedUrl} readOnly onFocus={(event) => event.currentTarget.select()} />
      <Button
        type="button"
        size="icon"
        aria-label="Copy booking link"
        disabled={!generatedUrl || isPending}
        onClick={() => copyGeneratedUrl(generatedUrl)}
      >
        <CopyIcon />
      </Button>
    </div>
    {copyState === "manual" && (
      <p className="text-sm text-muted-foreground">
        Select the link field and copy it manually.
      </p>
    )}
  </CardContent>
</Card>
```

**Key implementation notes:**
- `new URL()` should throw for invalid `bookingBaseUrl`; Phase 4 must prevent enabling invalid URLs.
- Preserve non-UTM query params automatically by mutating `searchParams`.
- Do not send generated URLs to PostHog or Convex in this phase.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/dm-links/[portalSlug]/_components/build-booking-url.ts` | Create | Pure URL builder |
| `app/dm-links/[portalSlug]/_components/dm-link-portal-client.tsx` | Modify | Selectors and copy controls |

---

### 3F — Responsive and Security Verification

**Type:** Manual / Frontend  
**Parallelizable:** No — runs after the portal UI is usable.

**What:** Verify the route in browser at desktop and mobile widths, public auth behavior, session expiration behavior, and generated URL correctness.

**Why:** This route is intentionally public; small mistakes can expose tenant registry data or break a critical operator workflow.

**Where:**
- `app/dm-links/[portalSlug]/page.tsx` (verify)
- `app/dm-links/[portalSlug]/_components/dm-link-portal-client.tsx` (verify)
- `proxy.ts` (verify)

**How:**

**Step 1: Run static checks.**

```bash
# Path: /Users/nimbus/dev/ptdom-crm
npx convex dev --once
pnpm tsc --noEmit
```

**Step 2: Start the app and verify route access.**

```bash
# Path: /Users/nimbus/dev/ptdom-crm
pnpm dev
```

Open `http://localhost:3000/dm-links/{portalSlug}` without a WorkOS session. It should render the password screen instead of redirecting to `/sign-in`.

**Step 3: Verify no pre-auth data exposure.**

Use browser devtools or page source before unlocking. There should be no tenant name, closer names, team names, campaign values, or Calendly URLs in the HTML payload.

**Step 4: Verify generated URLs.**

Use a base URL such as `https://calendly.com/acme/demo?hide_gdpr_banner=1&utm_source=old`. The generated link should keep `hide_gdpr_banner=1` and overwrite all three UTM params.

**Key implementation notes:**
- If `/dm-links` redirects to WorkOS, check `PUBLIC_PREFIXES` and `proxy.ts` matcher behavior.
- If unlocking works but refresh locks again, inspect cookie path and slug-specific cookie name.
- If text overflows on mobile, constrain grids and inputs rather than shrinking font size with viewport units.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `proxy.ts` | Verify | Public route bypass |
| `app/dm-links/[portalSlug]/page.tsx` | Verify | Cookie/bootstrap behavior |
| `app/dm-links/[portalSlug]/_components/dm-link-portal-client.tsx` | Verify | Responsive UI |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `proxy.ts` | Modify | 3A |
| `app/dm-links/[portalSlug]/page.tsx` | Create | 3A |
| `app/dm-links/[portalSlug]/loading.tsx` | Create | 3A |
| `app/dm-links/[portalSlug]/actions.ts` | Create | 3B |
| `convex/linkPortal/portalQueries.ts` | Create | 3C |
| `convex/linkPortal/portalActions.ts` | Create | 3C |
| `app/dm-links/[portalSlug]/_components/dm-link-portal-client.tsx` | Create / Modify | 3A, 3D, 3E |
| `app/dm-links/[portalSlug]/_components/build-booking-url.ts` | Create | 3E |
