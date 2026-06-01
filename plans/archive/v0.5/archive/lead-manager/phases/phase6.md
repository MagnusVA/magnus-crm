# Phase 6 — Frontend: Merge Page + Pipeline Banner Enhancement

**Goal:** After this phase, any CRM user can navigate from a lead's detail page to `/workspace/leads/[leadId]/merge`, search for a target lead, review a full-screen side-by-side preview of what the merge will do, and confirm the irreversible merge. After merge, the user is redirected to the surviving lead's detail page. Additionally, the existing `PotentialDuplicateBanner` on the meeting detail page gains "Dismiss" and "Review & Merge" action buttons so closers can act on duplicate flags without leaving the meeting context.

**Prerequisite:** Phase 2 (`getMergePreview`, `searchLeads` queries deployed), Phase 3 (`mergeLead`, `dismissDuplicateFlag` mutations deployed), Phase 5 (lead detail page exists at `/workspace/leads/[leadId]` so back navigation and post-merge redirect work).

**Runs in PARALLEL with:** Nothing -- this is the final phase of Feature C.

**Skills to invoke:**
- `frontend-design` -- merge preview layout (side-by-side comparison cards, multi-step flow with clear visual progression)
- `shadcn` -- Card, Alert, Button, Badge components used in the merge page and banner enhancement
- `web-design-guidelines` -- WCAG compliance for destructive action (merge confirmation), keyboard navigation through search results, accessible step indicator
- `expect` -- full end-to-end browser test of merge flow (search -> preview -> confirm -> redirect) and banner enhancement (dismiss + review & merge buttons)

**Acceptance Criteria:**
1. Navigating to `/workspace/leads/[leadId]/merge` renders the merge page with a back link to the source lead's detail page.
2. The search step uses the shared `LeadSearchInput` component from Phase 4 and displays results from `searchLeads` (excluding the source lead).
3. Selecting a target lead transitions to the preview step, which renders a side-by-side comparison using `getMergePreview` data.
4. The preview shows: source lead card (left, "will be absorbed"), target lead card (right, "will survive"), identifiers being moved (highlighted), duplicate identifiers (dimmed), and opportunity count transfer summary.
5. The confirmation step displays an irreversibility warning (`Alert` with `AlertTriangleIcon`) naming both leads.
6. Clicking "Confirm Merge" calls `mergeLead` mutation, shows a spinner ("Merging..."), and on success: displays a success toast and executes `router.replace(`/workspace/leads/${targetLeadId}`)`.
7. On merge failure, an error `Alert` is shown on the merge page and the user can retry or choose a different target.
8. "Choose a different lead" button resets to the search step, clearing the target selection.
9. The `PotentialDuplicateBanner` on the meeting detail page now renders a "Dismiss" button that calls `dismissDuplicateFlag({ opportunityId })` and a "Review & Merge" button that calls `window.open(`/workspace/leads/${currentLeadId}/merge`, "_blank")`.
10. After dismissing, the banner disappears (Convex reactivity clears `potentialDuplicateLeadId` on the opportunity).
11. The merge page loading skeleton matches the layout dimensions to prevent CLS.
12. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
6A (Route files: page.tsx + loading.tsx) ──────────────────┐
                                                           ├── 6B (Merge page client component — uses route + imports 6C)
6C (Merge preview component) ─────────────────────────────┘
                                                           
6D (Pipeline duplicate banner enhancement) ───── (independent — different file)
```

**Optimal execution:**
1. Start **6A**, **6C**, and **6D** all in parallel (they touch different files with no overlap).
2. Once 6A and 6C are complete -> start **6B** (imports the route params from 6A and the `MergePreview` component from 6C).

**Estimated time:** 1-2 days

---

## Subphases

### 6A -- Route Files: `[leadId]/merge/page.tsx` + `loading.tsx`

**Type:** Frontend
**Parallelizable:** Yes -- no dependency on other subphases. 6B depends on this (the route must exist for the client component to mount).

**What:** Create the merge route page file and loading skeleton at `app/workspace/leads/[leadId]/merge/`. The page file is a thin RSC wrapper that renders the `MergePageClient` component. The loading file renders a merge-specific skeleton matching the page layout.

**Why:** Next.js App Router requires a `page.tsx` to register the route. The `loading.tsx` provides instant visual feedback while the client component hydrates and the Convex queries load. Without these files, navigating to `/workspace/leads/[leadId]/merge` returns a 404.

**Where:**
- `app/workspace/leads/[leadId]/merge/page.tsx` (new)
- `app/workspace/leads/[leadId]/merge/loading.tsx` (new)

**How:**

**Step 1: Create the page file**

```tsx
// Path: app/workspace/leads/[leadId]/merge/page.tsx
import { MergePageClient } from "./_components/merge-page-client";

export const unstable_instant = false;

export default function MergePage() {
  return <MergePageClient />;
}
```

**Step 2: Create the loading skeleton**

The skeleton mirrors the merge page layout: back link area, page header, and a card placeholder for the search/preview area.

```tsx
// Path: app/workspace/leads/[leadId]/merge/loading.tsx
import { Skeleton } from "@/components/ui/skeleton";

export default function MergePageLoading() {
  return (
    <div className="flex flex-col gap-6">
      {/* Back link skeleton */}
      <div className="flex items-center gap-4">
        <Skeleton className="h-9 w-36" />
      </div>

      {/* Page header skeleton */}
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-80" />
      </div>

      {/* Search card skeleton */}
      <div className="rounded-lg border p-6">
        <Skeleton className="mb-4 h-5 w-64" />
        <Skeleton className="h-10 w-full" />
      </div>
    </div>
  );
}
```

**Key implementation notes:**
- `export const unstable_instant = false` on the page file signals the PPR-ready architecture, consistent with every other workspace page (see AGENTS.md "Pages" pattern).
- The loading skeleton uses dimension-matched `<Skeleton />` primitives to prevent CLS. The `h-9 w-36` back link, `h-8 w-48` heading, and full-width search input match the actual merge page layout.
- The skeleton includes `role="status"` and `aria-label` via the `Skeleton` component's built-in accessibility.
- The `_components/` directory for the client component is created in subphase 6B.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/leads/[leadId]/merge/page.tsx` | Create | Thin RSC wrapper with `unstable_instant = false` |
| `app/workspace/leads/[leadId]/merge/loading.tsx` | Create | Layout-matched skeleton for instant feedback |

---

### 6B -- Merge Page Client Component

**Type:** Frontend
**Parallelizable:** No -- depends on 6A (route files must exist) and 6C (`MergePreview` component import). Must be the last merge-page subphase.

**What:** Create the `MergePageClient` component at `app/workspace/leads/[leadId]/merge/_components/merge-page-client.tsx`. This is the interactive boundary for the merge flow: a multi-step state machine (`search` -> `preview` -> `confirming`) that orchestrates the search input, preview component, irreversibility warning, and merge execution.

**Why:** The merge flow is a focused, deliberate workflow -- not a quick modal. A full-page client component gives the user dedicated screen real estate for each step, clear navigation between steps, and explicit confirmation before an irreversible action. The multi-step pattern prevents accidental merges by requiring three distinct user actions (search -> select -> confirm).

**Where:**
- `app/workspace/leads/[leadId]/merge/_components/merge-page-client.tsx` (new)

**How:**

**Step 1: Create the client component file with imports and types**

```tsx
// Path: app/workspace/leads/[leadId]/merge/_components/merge-page-client.tsx
"use client";

import { useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { usePageTitle } from "@/hooks/use-page-title";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { LeadSearchInput } from "../../../_components/lead-search-input";
import { MergePreview } from "./merge-preview";
import { toast } from "sonner";
import Link from "next/link";
import {
  ArrowLeftIcon,
  AlertTriangleIcon,
  Loader2Icon,
} from "lucide-react";

type MergeStep = "search" | "preview" | "confirming";
```

**Step 2: Build the component with state management, queries, and handlers**

```tsx
// Path: app/workspace/leads/[leadId]/merge/_components/merge-page-client.tsx (continued)

export function MergePageClient() {
  const params = useParams<{ leadId: string }>();
  const router = useRouter();
  const sourceLeadId = params.leadId as Id<"leads">;

  const [step, setStep] = useState<MergeStep>("search");
  const [searchTerm, setSearchTerm] = useState("");
  const [targetLeadId, setTargetLeadId] = useState<Id<"leads"> | null>(null);
  const [error, setError] = useState<string | null>(null);

  usePageTitle("Merge Lead");

  // Load source lead info for display (name in header + back link)
  const sourceLead = useQuery(api.leads.queries.getLeadDetail, {
    leadId: sourceLeadId,
  });

  const mergeLead = useMutation(api.leads.merge.mergeLead);

  // Search for target leads — skip query when search term is empty
  const searchResults = useQuery(
    api.leads.queries.searchLeads,
    searchTerm.trim().length > 0
      ? { searchTerm: searchTerm.trim(), statusFilter: "active" }
      : "skip",
  );
  // Exclude the source lead from search results — prevent self-merge in UI
  const filteredResults = (searchResults ?? []).filter(
    (lead) => lead._id !== sourceLeadId,
  );

  // Preview query — only fires when a target is selected
  const preview = useQuery(
    api.leads.queries.getMergePreview,
    targetLeadId ? { sourceLeadId, targetLeadId } : "skip",
  );

  const handleSelectTarget = useCallback((leadId: Id<"leads">) => {
    setTargetLeadId(leadId);
    setStep("preview");
    setError(null);
  }, []);

  const handleConfirmMerge = useCallback(async () => {
    if (!targetLeadId) return;
    setStep("confirming");
    setError(null);

    try {
      await mergeLead({ sourceLeadId, targetLeadId });
      toast.success("Leads merged successfully");
      // Redirect to the surviving (target) lead's detail page
      router.replace(`/workspace/leads/${targetLeadId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Merge failed");
      setStep("preview"); // Return to preview step so user can retry or choose another target
    }
  }, [sourceLeadId, targetLeadId, mergeLead, router]);

  const handleBackToSearch = useCallback(() => {
    setStep("search");
    setTargetLeadId(null);
    setError(null);
  }, []);

  const sourceLeadName =
    sourceLead?.lead?.fullName ?? sourceLead?.lead?.email ?? "Lead";

  return (
    <div className="flex flex-col gap-6">
      {/* Back navigation — always visible, returns to source lead's detail page */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" asChild>
          <Link href={`/workspace/leads/${sourceLeadId}`}>
            <ArrowLeftIcon data-icon="inline-start" />
            Back to {sourceLeadName}
          </Link>
        </Button>
      </div>

      {/* Page header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Merge Lead</h1>
        <p className="text-sm text-muted-foreground">
          Merge &ldquo;{sourceLeadName}&rdquo; into another lead. All
          opportunities and identifiers will be transferred to the target.
        </p>
      </div>

      {/* Error alert — shown on merge failure */}
      {error && (
        <Alert variant="destructive">
          <AlertTriangleIcon className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Step 1: Search for target lead */}
      {step === "search" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Search for the lead to merge into
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <LeadSearchInput value={searchTerm} onChange={setSearchTerm} />

            {/* Search results grid */}
            {filteredResults.length > 0 && (
              <div className="grid gap-2 sm:grid-cols-2">
                {filteredResults.map((lead) => (
                  <button
                    key={lead._id}
                    type="button"
                    className="flex flex-col gap-1 rounded-lg border p-4 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => handleSelectTarget(lead._id)}
                  >
                    <p className="text-sm font-medium">
                      {lead.fullName ?? lead.email}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {lead.email}
                    </p>
                    {lead.socialHandles && lead.socialHandles.length > 0 && (
                      <p className="text-xs text-muted-foreground">
                        {lead.socialHandles
                          .map((s) => `@${s.handle}`)
                          .join(", ")}
                      </p>
                    )}
                  </button>
                ))}
              </div>
            )}

            {/* Empty search results */}
            {searchTerm.trim().length > 0 &&
              searchResults !== undefined &&
              filteredResults.length === 0 && (
                <p className="text-center text-sm text-muted-foreground py-4">
                  No leads found matching &ldquo;{searchTerm.trim()}&rdquo;.
                  Try adjusting your search.
                </p>
              )}
          </CardContent>
        </Card>
      )}

      {/* Step 2 + 3: Preview and confirm */}
      {(step === "preview" || step === "confirming") && preview && (
        <>
          <MergePreview data={preview} />

          {/* Irreversibility warning */}
          <Alert>
            <AlertTriangleIcon className="h-4 w-4" />
            <AlertDescription>
              <strong>This action is irreversible.</strong>{" "}
              &ldquo;{preview.source.lead.fullName ?? preview.source.lead.email}
              &rdquo; will be permanently merged into &ldquo;
              {preview.target.lead.fullName ?? preview.target.lead.email}&rdquo;.
              All opportunities and identifiers will be transferred. The source
              lead will be marked as merged and can no longer be accessed.
            </AlertDescription>
          </Alert>

          {/* Action buttons */}
          <div className="flex items-center justify-between">
            <Button
              variant="outline"
              onClick={handleBackToSearch}
              disabled={step === "confirming"}
            >
              Choose a different lead
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirmMerge}
              disabled={step === "confirming"}
            >
              {step === "confirming" ? (
                <>
                  <Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
                  Merging...
                </>
              ) : (
                "Confirm Merge"
              )}
            </Button>
          </div>
        </>
      )}

      {/* Preview loading state — target selected but preview query not yet resolved */}
      {(step === "preview" || step === "confirming") && !preview && (
        <div className="flex items-center justify-center py-12">
          <Spinner className="h-6 w-6" />
          <span className="ml-2 text-sm text-muted-foreground">
            Loading merge preview...
          </span>
        </div>
      )}
    </div>
  );
}
```

**Key implementation notes:**
- **Multi-step state machine**: `useState<MergeStep>` drives the UI. Only one step renders at a time. This prevents accidental confirmation -- the user must explicitly click through search -> select -> confirm.
- **`useQuery` with `"skip"`**: Both `searchLeads` and `getMergePreview` use Convex's skip sentinel to avoid unnecessary queries. `searchLeads` skips when the search term is empty; `getMergePreview` skips when no target is selected.
- **Source lead exclusion**: `filteredResults` removes the source lead from search results client-side. This is a defense-in-depth measure -- the backend `mergeLead` mutation also rejects self-merges.
- **Error recovery**: On merge failure, `setStep("preview")` returns the user to the preview step (not search). This lets them retry the merge or choose a different target without losing their preview context.
- **`router.replace` (not `router.push`)**: After a successful merge, replace (not push) ensures the user cannot navigate "back" to the merged source lead's merge page. The source lead no longer exists in an actionable state.
- **`handleBackToSearch` clears target**: Resetting `targetLeadId` to `null` causes the `getMergePreview` query to skip, freeing resources.
- **Search result buttons**: Each result is a `<button>` (not `<a>`) with `type="button"` -- they trigger an in-page state change, not navigation. `focus-visible:ring-2` ensures keyboard accessibility.
- **Empty search state**: Only shown when search term is non-empty AND `searchResults` has resolved (not `undefined`) AND `filteredResults` is empty. This prevents a flash of "no results" while the query loads.
- **Preview loading state**: When the target is selected but `getMergePreview` hasn't resolved yet, a centered spinner with text is shown instead of a blank page.
- **`usePageTitle("Merge Lead")`**: Sets the document title for the merge page, restored on unmount (matching the custom hook pattern from AGENTS.md).
- **Back link uses `Link` (not `router.back()`)**: Explicit `Link` to the source lead's detail page is more predictable than `router.back()` because the user may have navigated here from a different entry point (e.g., a bookmarked URL or the duplicate banner's "Review & Merge" button).
- **Destructive button**: `variant="destructive"` on "Confirm Merge" visually signals the irreversible nature of the action. The "Choose a different lead" button uses `variant="outline"` to be clearly secondary.
- **`disabled` during confirming**: Both the back button and confirm button are disabled while the merge mutation is in flight to prevent double-submit or navigation mid-operation.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/leads/[leadId]/merge/_components/merge-page-client.tsx` | Create | Multi-step merge flow with search, preview, confirm, error handling |

---

### 6C -- Merge Preview Component

**Type:** Frontend
**Parallelizable:** Yes -- independent of 6A and 6D. Can be built before 6B exists. 6B imports this component.

**What:** Create the `MergePreview` component at `app/workspace/leads/[leadId]/merge/_components/merge-preview.tsx`. This renders the side-by-side comparison of source and target leads using the data returned by `getMergePreview`. It shows lead info cards, identifier transfer details, and an opportunity count summary.

**Why:** The merge preview is the core decision-making surface for the merge flow. Users need to see exactly what will happen before confirming. The side-by-side layout creates a clear mental model: "this lead (left) will be absorbed into that lead (right)." Identifiers and opportunity counts let the user verify they're merging the right records. Without this component, the user would be confirming a merge blindly.

**Where:**
- `app/workspace/leads/[leadId]/merge/_components/merge-preview.tsx` (new)

**How:**

**Step 1: Create the preview component file**

```tsx
// Path: app/workspace/leads/[leadId]/merge/_components/merge-preview.tsx
"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  ArrowRightIcon,
  MailIcon,
  PhoneIcon,
  AtSignIcon,
  BriefcaseIcon,
  TagIcon,
} from "lucide-react";

type MergePreviewData = {
  source: {
    lead: {
      _id: string;
      fullName?: string;
      email: string;
      phone?: string;
    };
    identifiers: Array<{
      type: string;
      value: string;
    }>;
    opportunityCount: number;
  };
  target: {
    lead: {
      _id: string;
      fullName?: string;
      email: string;
      phone?: string;
    };
    identifiers: Array<{
      type: string;
      value: string;
    }>;
    opportunityCount: number;
  };
  preview: {
    identifiersToMove: Array<{
      type: string;
      value: string;
    }>;
    duplicateIdentifiers: Array<{
      type: string;
      value: string;
    }>;
    opportunitiesToMove: number;
    totalOpportunitiesAfterMerge: number;
  };
};

type MergePreviewProps = {
  data: MergePreviewData;
};
```

**Step 2: Build the identifier icon helper**

```tsx
// Path: app/workspace/leads/[leadId]/merge/_components/merge-preview.tsx (continued)

/** Map identifier type to a semantic icon */
function IdentifierIcon({ type }: { type: string }) {
  switch (type) {
    case "email":
      return <MailIcon className="size-3.5 shrink-0" />;
    case "phone":
      return <PhoneIcon className="size-3.5 shrink-0" />;
    case "social":
      return <AtSignIcon className="size-3.5 shrink-0" />;
    default:
      return <TagIcon className="size-3.5 shrink-0" />;
  }
}
```

**Step 3: Build the lead card sub-component**

```tsx
// Path: app/workspace/leads/[leadId]/merge/_components/merge-preview.tsx (continued)

function LeadCard({
  lead,
  identifiers,
  opportunityCount,
  role,
}: {
  lead: MergePreviewData["source"]["lead"];
  identifiers: MergePreviewData["source"]["identifiers"];
  opportunityCount: number;
  role: "source" | "target";
}) {
  const isSource = role === "source";

  return (
    <Card
      className={
        isSource
          ? "border-red-200 dark:border-red-900/50"
          : "border-green-200 dark:border-green-900/50"
      }
    >
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <Badge
            variant="outline"
            className={
              isSource
                ? "border-red-300 text-red-700 dark:border-red-800 dark:text-red-400"
                : "border-green-300 text-green-700 dark:border-green-800 dark:text-green-400"
            }
          >
            {isSource ? "Will be absorbed" : "Will survive"}
          </Badge>
        </div>
        <CardTitle className="text-lg">
          {lead.fullName ?? lead.email}
        </CardTitle>
        <CardDescription>{lead.email}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {/* Identifiers */}
        {identifiers.length > 0 && (
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Identifiers
            </p>
            <ul className="flex flex-col gap-1" aria-label={`${isSource ? "Source" : "Target"} lead identifiers`}>
              {identifiers.map((id, idx) => (
                <li
                  key={`${id.type}-${id.value}-${idx}`}
                  className="flex items-center gap-2 text-sm"
                >
                  <IdentifierIcon type={id.type} />
                  <span className="truncate">{id.value}</span>
                  <Badge variant="secondary" className="ml-auto text-[10px] shrink-0">
                    {id.type}
                  </Badge>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Opportunity count */}
        <div className="flex items-center gap-2 text-sm">
          <BriefcaseIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span>
            {opportunityCount} {opportunityCount === 1 ? "opportunity" : "opportunities"}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
```

**Step 4: Build the main preview component with side-by-side layout and transfer summary**

```tsx
// Path: app/workspace/leads/[leadId]/merge/_components/merge-preview.tsx (continued)

export function MergePreview({ data }: MergePreviewProps) {
  const { source, target, preview } = data;

  return (
    <div className="flex flex-col gap-4">
      {/* Side-by-side lead cards */}
      <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-[1fr_auto_1fr]">
        {/* Source lead (left) — will be absorbed */}
        <LeadCard
          lead={source.lead}
          identifiers={source.identifiers}
          opportunityCount={source.opportunityCount}
          role="source"
        />

        {/* Merge direction arrow — visible on md+, hidden on mobile */}
        <div className="hidden md:flex md:items-center md:justify-center md:self-center">
          <ArrowRightIcon className="size-6 text-muted-foreground" aria-label="merges into" />
        </div>

        {/* Target lead (right) — will survive */}
        <LeadCard
          lead={target.lead}
          identifiers={target.identifiers}
          opportunityCount={target.opportunityCount}
          role="target"
        />
      </div>

      {/* Transfer summary card */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Merge Summary</CardTitle>
          <CardDescription>
            What will happen when the merge is confirmed.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {/* Identifiers being moved */}
          {preview.identifiersToMove.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Identifiers to transfer
              </p>
              <ul className="flex flex-wrap gap-1.5" aria-label="Identifiers that will be transferred to the target lead">
                {preview.identifiersToMove.map((id, idx) => (
                  <li key={`move-${id.type}-${id.value}-${idx}`}>
                    <Badge variant="default" className="gap-1">
                      <IdentifierIcon type={id.type} />
                      {id.value}
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Duplicate identifiers (already exist on target) */}
          {preview.duplicateIdentifiers.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Already on target (will not move)
              </p>
              <ul className="flex flex-wrap gap-1.5" aria-label="Identifiers that already exist on the target lead">
                {preview.duplicateIdentifiers.map((id, idx) => (
                  <li key={`dup-${id.type}-${id.value}-${idx}`}>
                    <Badge variant="secondary" className="gap-1 opacity-60">
                      <IdentifierIcon type={id.type} />
                      {id.value}
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Opportunity transfer summary */}
          <div className="rounded-md border bg-muted/50 px-4 py-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                Opportunities transferring
              </span>
              <span className="font-medium">{preview.opportunitiesToMove}</span>
            </div>
            <div className="mt-1 flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                Total on target after merge
              </span>
              <span className="font-semibold">
                {preview.totalOpportunitiesAfterMerge}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
```

**Key implementation notes:**
- **Side-by-side layout**: Uses `grid-cols-[1fr_auto_1fr]` on `md+` for a source-arrow-target layout. On mobile, the cards stack vertically (source on top, target below) with the arrow hidden. This provides a clear comparison on desktop and a scannable list on mobile.
- **Color-coded cards**: Source card has red border (`border-red-200`), target has green border (`border-green-200`). Red = "will be absorbed" (destructive), green = "will survive" (safe). Both have dark mode variants.
- **Badge roles**: `"Will be absorbed"` (red) and `"Will survive"` (green) badges at the top of each card make the merge direction immediately clear, even for users unfamiliar with left-to-right merge conventions.
- **Identifier transfer visualization**: `identifiersToMove` are rendered with `variant="default"` badges (prominent, highlighted). `duplicateIdentifiers` use `variant="secondary"` with `opacity-60` (dimmed) to show they already exist on the target and won't be duplicated.
- **`IdentifierIcon` helper**: Maps identifier types to semantic icons. This reuses `lucide-react` icons that are already in the project's optimized imports.
- **Opportunity summary**: A subtle `bg-muted/50` section shows the count of opportunities transferring and the total after merge. Uses `font-medium` and `font-semibold` to create visual hierarchy.
- **Accessibility**: `aria-label` on identifier lists, `aria-label` on the arrow icon, and semantic `<ul>/<li>` structure ensure screen readers can parse the comparison.
- **Truncation**: Identifier values use `truncate` to handle long emails or social handles without breaking the layout.
- **No state or hooks**: `MergePreview` is purely presentational -- it receives data as props and renders. This makes it easy to test in isolation and allows 6B to control all state.
- **Type definition**: `MergePreviewData` matches the return shape of `getMergePreview` from Phase 2. The type is defined locally (not imported from Convex) because the client-side type uses `string` for IDs.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/leads/[leadId]/merge/_components/merge-preview.tsx` | Create | Side-by-side preview with identifier transfer details and opportunity summary |

---

### 6D -- Pipeline Duplicate Banner Enhancement

**Type:** Frontend
**Parallelizable:** Yes -- independent of 6A, 6B, 6C (touches a different file in a different directory). Can be developed and tested in isolation.

**What:** Modify the existing `PotentialDuplicateBanner` in `app/workspace/closer/meetings/_components/potential-duplicate-banner.tsx` to add two new props (`opportunityId`, `currentLeadId`) and two new action buttons: "Dismiss" (calls `dismissDuplicateFlag` mutation) and "Review & Merge" (opens the merge page in a new tab). Also update the banner's usage in `meeting-detail-page-client.tsx` to pass the new props.

**Why:** The existing banner is informational only -- it tells the user about a potential duplicate but offers no way to act on it. Adding "Dismiss" lets closers clear false positives without leaving the meeting page. "Review & Merge" opens the merge page in a new tab so the user can resolve the duplicate in a focused context while keeping the meeting detail page open. This bridges Feature E's detection with Feature C's resolution.

**Where:**
- `app/workspace/closer/meetings/_components/potential-duplicate-banner.tsx` (modify)
- `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx` (modify)

**How:**

**Step 1: Update the banner component props and add action buttons**

Before (entire file):

```tsx
// Path: app/workspace/closer/meetings/_components/potential-duplicate-banner.tsx
"use client";

import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { UsersIcon } from "lucide-react";

type PotentialDuplicateBannerProps = {
  duplicateLead: {
    _id: string;
    fullName?: string;
    email: string;
  };
  currentLeadName?: string;
};

/**
 * Non-blocking informational banner shown on the meeting detail page
 * when the pipeline detected a potential duplicate lead during identity resolution.
 *
 * Displays the suspected duplicate's name and email. In Feature C (Lead Manager),
 * this banner will gain a "Review & Merge" action button.
 */
export function PotentialDuplicateBanner({
  duplicateLead,
  currentLeadName,
}: PotentialDuplicateBannerProps) {
  const duplicateLeadLabel = duplicateLead.fullName ?? duplicateLead.email;
  const showEmailDetail = duplicateLead.fullName !== undefined;

  return (
    <Alert
      role="status"
      variant="default"
      className="border-amber-500 bg-amber-50 dark:bg-amber-950/20"
    >
      <UsersIcon aria-hidden="true" className="text-amber-600 dark:text-amber-400" />
      <AlertTitle className="text-amber-800 dark:text-amber-200">
        Potential Duplicate Lead
      </AlertTitle>
      <AlertDescription className="break-words text-amber-700 dark:text-amber-300">
        {currentLeadName ? (
          <>
            <span className="font-medium">{currentLeadName}</span> might be the
            same person as{" "}
            <span className="font-medium">{duplicateLeadLabel}</span>
            {showEmailDetail ? ` (${duplicateLead.email})` : null}.
          </>
        ) : (
          <>
            This lead might be the same as{" "}
            <span className="font-medium">{duplicateLeadLabel}</span>
            {showEmailDetail ? ` (${duplicateLead.email})` : null}.
          </>
        )}{" "}
        Review their profiles to determine if they should be merged.
      </AlertDescription>
    </Alert>
  );
}
```

After (entire file):

```tsx
// Path: app/workspace/closer/meetings/_components/potential-duplicate-banner.tsx
"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { UsersIcon, ExternalLinkIcon } from "lucide-react";
import { toast } from "sonner";

type PotentialDuplicateBannerProps = {
  duplicateLead: {
    _id: string;
    fullName?: string;
    email: string;
  };
  currentLeadName?: string;
  /** The opportunity that has the potentialDuplicateLeadId flag. Required for dismiss. */
  opportunityId: Id<"opportunities">;
  /** The current lead's ID. Used to build the merge page URL. */
  currentLeadId: string;
};

/**
 * Non-blocking informational banner shown on the meeting detail page
 * when the pipeline detected a potential duplicate lead during identity resolution.
 *
 * Displays the suspected duplicate's name and email with action buttons:
 * - "Dismiss" — clears the duplicate flag on the opportunity (for false positives)
 * - "Review & Merge" — opens the current lead's merge page in a new tab
 */
export function PotentialDuplicateBanner({
  duplicateLead,
  currentLeadName,
  opportunityId,
  currentLeadId,
}: PotentialDuplicateBannerProps) {
  const duplicateLeadLabel = duplicateLead.fullName ?? duplicateLead.email;
  const showEmailDetail = duplicateLead.fullName !== undefined;

  const dismissDuplicateFlag = useMutation(
    api.leads.merge.dismissDuplicateFlag,
  );
  const [isDismissing, setIsDismissing] = useState(false);

  const handleDismiss = async () => {
    setIsDismissing(true);
    try {
      await dismissDuplicateFlag({ opportunityId });
      toast.success("Duplicate flag dismissed");
      // Banner will disappear via Convex reactivity — potentialDuplicateLeadId
      // is cleared on the opportunity, getMeetingDetail re-fires, potentialDuplicate
      // becomes null, conditional render removes the banner.
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to dismiss",
      );
      setIsDismissing(false);
    }
  };

  const handleReviewAndMerge = () => {
    window.open(`/workspace/leads/${currentLeadId}/merge`, "_blank");
  };

  return (
    <Alert
      role="status"
      variant="default"
      className="border-amber-500 bg-amber-50 dark:bg-amber-950/20"
    >
      <UsersIcon aria-hidden="true" className="text-amber-600 dark:text-amber-400" />
      <AlertTitle className="text-amber-800 dark:text-amber-200">
        Potential Duplicate Lead
      </AlertTitle>
      <AlertDescription className="break-words text-amber-700 dark:text-amber-300">
        {currentLeadName ? (
          <>
            <span className="font-medium">{currentLeadName}</span> might be the
            same person as{" "}
            <span className="font-medium">{duplicateLeadLabel}</span>
            {showEmailDetail ? ` (${duplicateLead.email})` : null}.
          </>
        ) : (
          <>
            This lead might be the same as{" "}
            <span className="font-medium">{duplicateLeadLabel}</span>
            {showEmailDetail ? ` (${duplicateLead.email})` : null}.
          </>
        )}{" "}
        Review their profiles to determine if they should be merged.
      </AlertDescription>

      {/* Action buttons */}
      <div className="mt-3 flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={handleDismiss}
          disabled={isDismissing}
          className="border-amber-300 text-amber-800 hover:bg-amber-100 dark:border-amber-800 dark:text-amber-300 dark:hover:bg-amber-900/30"
        >
          {isDismissing ? "Dismissing..." : "Dismiss"}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={handleReviewAndMerge}
          className="gap-1.5"
        >
          Review & Merge
          <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
        </Button>
      </div>
    </Alert>
  );
}
```

**Step 2: Update the banner's usage in `meeting-detail-page-client.tsx`**

The `PotentialDuplicateBanner` now requires two additional props: `opportunityId` and `currentLeadId`. Update the conditional render block where the banner is used.

Before:

```tsx
// Path: app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx

      {/* Feature E: Potential duplicate banner */}
      {potentialDuplicate && (
        <PotentialDuplicateBanner
          duplicateLead={potentialDuplicate}
          currentLeadName={lead.fullName}
        />
      )}
```

After:

```tsx
// Path: app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx

      {/* Feature E/C: Potential duplicate banner with dismiss + merge actions */}
      {potentialDuplicate && (
        <PotentialDuplicateBanner
          duplicateLead={potentialDuplicate}
          currentLeadName={lead.fullName}
          opportunityId={opportunity._id}
          currentLeadId={lead._id}
        />
      )}
```

**Key implementation notes:**
- **Prop additions are non-breaking for existing behavior**: The banner still renders the same text content. The new props add action capabilities. `opportunityId` comes from the already-destructured `opportunity` in the page client. `currentLeadId` comes from the already-destructured `lead` (using `lead._id`, which is serialized as a `string` by Convex).
- **Dismiss flow**: `dismissDuplicateFlag({ opportunityId })` clears `potentialDuplicateLeadId` on the opportunity. Because `getMeetingDetail` is a reactive Convex query, the `potentialDuplicate` field in the query result becomes `null`, the conditional render (`{potentialDuplicate && ...}`) evaluates to false, and the banner disappears without any explicit state management in the parent.
- **`isDismissing` state**: Prevents double-click during the mutation. No explicit `setIsDismissing(false)` on success -- the banner unmounts via reactivity before the state update would fire.
- **`window.open` with `"_blank"`**: Opens the merge page in a new tab. This preserves the user's meeting detail context in the original tab. The merge page's back link returns to the source lead's detail page (not the meeting detail).
- **`ExternalLinkIcon`**: Visually signals that "Review & Merge" opens a new tab, following web conventions. `aria-hidden="true"` prevents screen readers from reading the icon.
- **Amber-themed Dismiss button**: Uses custom amber border and text colors to match the banner's amber theme, keeping the button visually cohesive with the alert rather than using the default outline style.
- **Button size**: Both buttons use `size="sm"` to keep the action area compact within the alert banner.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/_components/potential-duplicate-banner.tsx` | Modify | Add `opportunityId` + `currentLeadId` props, "Dismiss" button, "Review & Merge" button |
| `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx` | Modify | Pass `opportunityId` and `currentLeadId` to `PotentialDuplicateBanner` |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `app/workspace/leads/[leadId]/merge/page.tsx` | Create | 6A |
| `app/workspace/leads/[leadId]/merge/loading.tsx` | Create | 6A |
| `app/workspace/leads/[leadId]/merge/_components/merge-page-client.tsx` | Create | 6B |
| `app/workspace/leads/[leadId]/merge/_components/merge-preview.tsx` | Create | 6C |
| `app/workspace/closer/meetings/_components/potential-duplicate-banner.tsx` | Modify | 6D |
| `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx` | Modify | 6D |

---

## Notes for Implementer

- **No new Convex functions**: This phase creates no backend code. All queries and mutations were implemented in Phases 2 and 3: `searchLeads`, `getMergePreview`, `getLeadDetail`, `mergeLead`, `dismissDuplicateFlag`. Phase 6 is purely frontend wiring.
- **Shared components**: `LeadSearchInput` (`app/workspace/leads/_components/lead-search-input.tsx`) from Phase 4 is imported by the merge page client. Verify the import path resolves correctly -- it uses a relative path from `merge/_components/` up to `leads/_components/` (`../../../_components/lead-search-input`).
- **TypeScript**: The `MergePreviewData` type in 6C is defined locally, not imported from Convex. It must match the shape returned by `getMergePreview`. If the backend return type changes, update the local type to match.
- **Routing**: The merge page is a nested route under the dynamic `[leadId]` segment. Next.js App Router resolves `app/workspace/leads/[leadId]/merge/page.tsx` automatically. No `next.config.ts` changes needed.
- **RBAC**: The merge page is accessible to all three CRM roles (`tenant_master`, `tenant_admin`, `closer`) -- per the Feature C design, closers can merge directly. The backend `mergeLead` mutation enforces `requireTenantUser(ctx, ["tenant_master", "tenant_admin", "closer"])`. No server-side route gating needed.
- **Dark mode**: Test both themes. The merge preview uses `dark:border-red-900/50` and `dark:border-green-900/50` for source/target card borders. Verify contrast in the `expect` skill's screenshot tool.
- **Responsive testing**: Run the `expect` skill at 4 viewports minimum. The side-by-side preview grid switches from `grid-cols-[1fr_auto_1fr]` on `md+` to stacked `grid-cols-1` on mobile. The merge arrow hides on mobile (`hidden md:flex`). Verify the search result cards stack cleanly on narrow viewports.
- **Accessibility**: The merge confirmation uses `variant="destructive"` to signal irreversibility visually. Screen readers receive the explicit warning text ("This action is irreversible...") in the `AlertDescription`. Identifier lists use `<ul>/<li>` with `aria-label` for semantic structure. Keyboard users can tab through search results (each result button has `focus-visible:ring-2`).
- **Read the Convex AI guidelines** (`convex/_generated/ai/guidelines.md`) even though this phase is frontend-only -- confirm that the `useQuery` skip patterns and `useMutation` usage follow the documented conventions.
