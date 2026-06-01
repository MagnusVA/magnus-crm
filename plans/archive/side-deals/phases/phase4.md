# Phase 4 - Frontend: Opportunity Create Page

**Goal:** Add `/workspace/opportunities/new`, a full-page creation flow where closers create side-deal opportunities for themselves and admins create side-deal opportunities on behalf of active closers. The page lets the user pick an existing lead or create a new MVP lead, then navigates to the new opportunity detail page.

**Prerequisite:** Phase 2 `createManual`, lead picker queries, and `listActiveClosers` are implemented and type-generated. Phase 3 navigation can be merged before or during this phase; the create page itself does not require the list table to be complete.

**Runs in PARALLEL with:** Phase 3 and Phase 5. This phase owns `/workspace/opportunities/new/*`; Phase 3 owns `/workspace/opportunities/page.tsx` and list components; Phase 5 owns `/workspace/opportunities/[opportunityId]/*`. Coordinate only if both Phase 3 and 4 edit `components/command-palette.tsx`.

**Skills to invoke:**
- `frontend-design` - keep the form spacious enough for the lead combobox while preserving a utilitarian CRM feel.
- `next-best-practices` - `useSearchParams()` must be behind Suspense; route file keeps `unstable_instant = false`.
- `shadcn` - use existing Form, RadioGroup, Popover/Command, Select, Card, Alert, Skeleton, and Button primitives.
- `vercel-react-best-practices` - keep mutation state local and avoid recreating schema/resolver on every keystroke.

---

## Acceptance Criteria

1. Navigating to `/workspace/opportunities/new` renders a full-page form, not a dialog.
2. The page has two visible sections: Lead and Opportunity.
3. Existing-lead mode requires selecting a lead from the combobox before submit.
4. New-lead mode requires full name and email; phone and social handle are optional.
5. Admin users must choose an active closer; closer users do not see the closer picker and are assigned server-side to themselves.
6. `/workspace/opportunities/new?leadId={leadId}` preselects that lead and renders the selected lead label before search results load.
7. On successful submit, the page calls `api.opportunities.createManual.createManual`, shows a success toast, captures a PostHog event, and routes to `/workspace/opportunities/{opportunityId}`.
8. Double-click/Enter-repeat does not create duplicate opportunities because the client holds one `clientRequestId` per submit attempt and the backend is idempotent.
9. Backend/validation errors render in an inline destructive alert and re-enable the form.
10. The page is usable at 390px width without overlapping labels, buttons, or combobox content.
11. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
4A (route shell + skeleton) ─────────────┐
                                         │
4B (Zod schema + form client shell) ─────┼── 4D (submit integration + posthog + navigation) ───┐
                                         │                                                     │
4C (LeadCombobox + CloserSelect) ────────┘                                                     ├── 4F (QA gate)
                                                                                               │
4E (deep-link polish + optional lead-detail CTA) ──────────────────────────────────────────────┘
```

**Optimal execution:**
1. Start **4A, 4B, and 4C in parallel**. 4A owns route/skeleton files, 4B owns form schema/page shell, 4C owns isolated picker components.
2. Start **4D** after 4B and 4C define stable form values and picker contracts.
3. Run **4E** after the form can read `leadId` from search params.
4. Run **4F** as the final browser/TypeScript gate.

**Estimated time:** 1.5-2 days solo, or 1 day with parallel route/form/picker streams.

---

## Subphases

### 4A - Route Shell and Skeleton

**Type:** Frontend
**Parallelizable:** Yes - owns new route files only.

**What:** Create the `/workspace/opportunities/new` route, Suspense wrapper, and loading skeleton.

**Why:** The page uses `useSearchParams()` for `leadId` deep-linking, so the client component must be wrapped in Suspense to avoid a CSR bailout.

**Where:**
- `app/workspace/opportunities/new/page.tsx` (new)
- `app/workspace/opportunities/new/_components/create-opportunity-skeleton.tsx` (new)

**How:**

**Step 1: Add the route page.**

```tsx
// Path: app/workspace/opportunities/new/page.tsx
import { Suspense } from "react";
import { CreateOpportunityPageClient } from "./_components/create-opportunity-page-client";
import { CreateOpportunitySkeleton } from "./_components/create-opportunity-skeleton";

export const unstable_instant = false;

export default function CreateOpportunityPage() {
  return (
    <Suspense fallback={<CreateOpportunitySkeleton />}>
      <CreateOpportunityPageClient />
    </Suspense>
  );
}
```

**Step 2: Add a stable form skeleton.**

```tsx
// Path: app/workspace/opportunities/new/_components/create-opportunity-skeleton.tsx
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function CreateOpportunitySkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6" role="status" aria-label="Loading new opportunity form">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-9 w-36" />
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-full max-w-lg" />
      </div>
      {[0, 1].map((index) => (
        <Card key={index}>
          <CardHeader>
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-4 w-64" />
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
```

**Key implementation notes:**
- Do not add a route-specific layout.
- Keep max width at `max-w-3xl`; this is a data-entry surface, not a dashboard.
- The workspace shell already provides page padding. Avoid adding `p-6` unless the route visually needs it after screenshot review.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/opportunities/new/page.tsx` | Create | Suspense-wrapped RSC route. |
| `app/workspace/opportunities/new/_components/create-opportunity-skeleton.tsx` | Create | Route fallback skeleton. |

---

### 4B - Zod Schema and Form Shell

**Type:** Frontend
**Parallelizable:** Yes - owns schema and main client shell; can run before pickers are complete using placeholder components.

**What:** Implement the React Hook Form + Zod schema and page layout.

**Why:** This repo standardizes on `standardSchemaResolver` with Zod v4 and shadcn Form primitives. The create flow needs cross-field validation for existing-vs-new lead and admin closer assignment.

**Where:**
- `app/workspace/opportunities/new/_components/create-opportunity-schema.ts` (new)
- `app/workspace/opportunities/new/_components/create-opportunity-page-client.tsx` (new)

**How:**

**Step 1: Add the schema factory.**

```typescript
// Path: app/workspace/opportunities/new/_components/create-opportunity-schema.ts
import { z } from "zod";

export function createOpportunitySchema({
  requireAssignedCloser,
}: {
  requireAssignedCloser: boolean;
}) {
  return z
    .object({
      leadMode: z.enum(["existing", "new"]),
      existingLeadId: z.string().optional(),
      newFullName: z.string().optional(),
      newEmail: z.string().email("Invalid email").optional().or(z.literal("")),
      newPhone: z.string().max(50).optional().or(z.literal("")),
      newSocialPlatform: z
        .enum(["instagram", "tiktok", "twitter", "facebook", "linkedin", "other_social"])
        .optional(),
      newSocialHandle: z.string().optional().or(z.literal("")),
      assignedCloserId: z.string().optional(),
      notes: z.string().max(2000).optional().or(z.literal("")),
    })
    .superRefine((data, ctx) => {
      if (data.leadMode === "existing" && !data.existingLeadId) {
        ctx.addIssue({ code: "custom", message: "Select a lead", path: ["existingLeadId"] });
      }
      if (data.leadMode === "new") {
        if (!data.newFullName?.trim()) {
          ctx.addIssue({ code: "custom", message: "Full name is required", path: ["newFullName"] });
        }
        if (!data.newEmail?.trim()) {
          ctx.addIssue({ code: "custom", message: "Email is required for new leads in MVP", path: ["newEmail"] });
        }
        if (data.newSocialPlatform && !data.newSocialHandle?.trim()) {
          ctx.addIssue({ code: "custom", message: "Enter the handle", path: ["newSocialHandle"] });
        }
        if (!data.newSocialPlatform && data.newSocialHandle?.trim()) {
          ctx.addIssue({ code: "custom", message: "Pick a platform", path: ["newSocialPlatform"] });
        }
      }
      if (requireAssignedCloser && !data.assignedCloserId) {
        ctx.addIssue({ code: "custom", message: "Pick an active closer", path: ["assignedCloserId"] });
      }
    });
}

export type CreateOpportunityFormValues = z.infer<
  ReturnType<typeof createOpportunitySchema>
>;
```

**Step 2: Build the page client shell.**

```tsx
// Path: app/workspace/opportunities/new/_components/create-opportunity-page-client.tsx
"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { ChevronLeftIcon } from "lucide-react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import posthog from "posthog-js";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useRole } from "@/components/auth/role-context";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { CloserSelect } from "./closer-select";
import { LeadCombobox } from "./lead-combobox";
import { createOpportunitySchema, type CreateOpportunityFormValues } from "./create-opportunity-schema";

export function CreateOpportunityPageClient() {
  const { isAdmin } = useRole();
  const router = useRouter();
  const searchParams = useSearchParams();
  const prefilledLeadId = searchParams.get("leadId") as Id<"leads"> | null;
  const createManual = useMutation(api.opportunities.createManual.createManual);
  const requestIdRef = useRef(crypto.randomUUID());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const schema = useMemo(
    () => createOpportunitySchema({ requireAssignedCloser: isAdmin }),
    [isAdmin],
  );

  const form = useForm({
    resolver: standardSchemaResolver(schema),
    defaultValues: {
      leadMode: "existing",
      existingLeadId: prefilledLeadId ?? undefined,
      newFullName: "",
      newEmail: "",
      newPhone: "",
      newSocialPlatform: undefined,
      newSocialHandle: "",
      assignedCloserId: undefined,
      notes: "",
    },
  });

  const leadMode = form.watch("leadMode");
```

**Step 3: Render the Lead and Opportunity sections.**

```tsx
// Path: app/workspace/opportunities/new/_components/create-opportunity-page-client.tsx
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-3 mb-2">
          <Link href="/workspace/opportunities">
            <ChevronLeftIcon data-icon="inline-start" />
            Back to opportunities
          </Link>
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">New opportunity</h1>
        <p className="text-sm text-muted-foreground">
          Create a side-deal opportunity, then record payment from its detail page.
        </p>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Lead</CardTitle>
              <CardDescription>Pick an existing lead or create a new one.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <FormField
                control={form.control}
                name="leadMode"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <RadioGroup value={field.value} onValueChange={field.onChange} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <label className="flex cursor-pointer items-center gap-2 rounded-md border p-3 has-[:checked]:border-primary">
                          <RadioGroupItem value="existing" />
                          <span>Existing lead</span>
                        </label>
                        <label className="flex cursor-pointer items-center gap-2 rounded-md border p-3 has-[:checked]:border-primary">
                          <RadioGroupItem value="new" />
                          <span>New lead</span>
                        </label>
                      </RadioGroup>
                    </FormControl>
                  </FormItem>
                )}
              />
              {leadMode === "existing" ? (
                <ExistingLeadField form={form} disabled={isSubmitting} />
              ) : (
                <NewLeadFields form={form} disabled={isSubmitting} />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Opportunity</CardTitle>
              <CardDescription>
                {isAdmin ? "Assign this side deal to an active closer." : "Add context for the deal."}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {isAdmin ? <AssignedCloserField form={form} disabled={isSubmitting} /> : null}
              <FormField
                control={form.control}
                name="notes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Notes</FormLabel>
                    <FormControl>
                      <Textarea rows={4} {...field} disabled={isSubmitting} placeholder="How did this opportunity come about?" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </CardContent>
          </Card>

          {submitError ? (
            <Alert variant="destructive">
              <AlertDescription>{submitError}</AlertDescription>
            </Alert>
          ) : null}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button asChild variant="outline" type="button" disabled={isSubmitting}>
              <Link href="/workspace/opportunities">Cancel</Link>
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? <Spinner data-icon="inline-start" /> : null}
              Create opportunity
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}
```

**Key implementation notes:**
- Do not pass an explicit generic to `useForm`; the Standard Schema resolver should infer values.
- `ExistingLeadField`, `NewLeadFields`, and `AssignedCloserField` can live in this file as local helpers unless the file becomes unwieldy. Extract only if it improves readability.
- Keep the submit button below both cards so validation reads top-to-bottom.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/opportunities/new/_components/create-opportunity-schema.ts` | Create | Zod v4 schema factory. |
| `app/workspace/opportunities/new/_components/create-opportunity-page-client.tsx` | Create | Form shell and section layout. |

---

### 4C - LeadCombobox and CloserSelect

**Type:** Frontend
**Parallelizable:** Yes - owns isolated components.

**What:** Build the debounced lead combobox and active closer select.

**Why:** These controls are the main UX difference from a simple form. They must be keyboard-friendly, bounded, and support deep-link preselection.

**Where:**
- `app/workspace/opportunities/new/_components/lead-combobox.tsx` (new)
- `app/workspace/opportunities/new/_components/closer-select.tsx` (new)

**How:**

**Step 1: Implement `LeadCombobox`.**

```tsx
// Path: app/workspace/opportunities/new/_components/lead-combobox.tsx
"use client";

import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { CheckIcon, ChevronsUpDownIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export function LeadCombobox({
  value,
  onChange,
  disabled,
}: {
  value?: Id<"leads">;
  onChange: (value: Id<"leads"> | undefined) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebounced(draft), 300);
    return () => window.clearTimeout(timeout);
  }, [draft]);

  const selectedLead = useQuery(
    api.leads.queries.getLeadForPicker,
    value ? { leadId: value } : "skip",
  );
  const results = useQuery(
    api.leads.queries.searchLeadsForPicker,
    debounced.trim().length >= 2 ? { searchTerm: debounced.trim() } : "skip",
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" aria-expanded={open} className="w-full justify-between" disabled={disabled}>
          {selectedLead ? (
            <span className="truncate">
              {selectedLead.fullName ?? selectedLead.email}
              <span className="ml-2 text-muted-foreground">{selectedLead.email}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">Search leads by name, email, or phone</span>
          )}
          <ChevronsUpDownIcon className="size-4 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Search leads" value={draft} onValueChange={setDraft} />
          <CommandList>
            {debounced.trim().length < 2 ? (
              <CommandEmpty>Type at least 2 characters.</CommandEmpty>
            ) : null}
            {debounced.trim().length >= 2 && results?.length === 0 ? (
              <CommandEmpty>No leads found. Switch to New lead.</CommandEmpty>
            ) : null}
            {results && results.length > 0 ? (
              <CommandGroup>
                {results.map((lead) => (
                  <CommandItem
                    key={lead._id}
                    value={lead._id}
                    onSelect={() => {
                      onChange(lead._id);
                      setOpen(false);
                    }}
                  >
                    <CheckIcon className={cn("size-4", value === lead._id ? "opacity-100" : "opacity-0")} />
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate font-medium">{lead.fullName ?? lead.email}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {lead.email} · {lead.status}
                      </span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
```

**Step 2: Implement `CloserSelect`.**

```tsx
// Path: app/workspace/opportunities/new/_components/closer-select.tsx
"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function CloserSelect({
  value,
  onChange,
  disabled,
}: {
  value?: Id<"users">;
  onChange: (value: Id<"users"> | undefined) => void;
  disabled?: boolean;
}) {
  const closers = useQuery(api.users.queries.listActiveClosers, {});

  return (
    <Select value={value} onValueChange={(next) => onChange(next as Id<"users">)} disabled={disabled || closers === undefined}>
      <SelectTrigger>
        <SelectValue placeholder={closers === undefined ? "Loading closers" : "Select closer"} />
      </SelectTrigger>
      <SelectContent>
        {closers?.map((closer) => (
          <SelectItem key={closer._id} value={closer._id}>
            {closer.fullName ?? closer.email}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
```

**Key implementation notes:**
- `Command shouldFilter={false}` is required because Convex search already filters server-side.
- `LeadCombobox` must still render selected lead labels from `getLeadForPicker` when `draft` is empty, so deep links work.
- Do not put a free-form "other closer" path in the UI. Admin assignment must be to active CRM closers only.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/opportunities/new/_components/lead-combobox.tsx` | Create | Debounced existing lead picker. |
| `app/workspace/opportunities/new/_components/closer-select.tsx` | Create | Admin active closer picker. |

---

### 4D - Submit Integration, Idempotency, Toasts, and Navigation

**Type:** Frontend
**Parallelizable:** No - depends on form values from 4B and picker components from 4C.

**What:** Implement the submit handler and telemetry around `createManual`.

**Why:** This connects UI to the backend invariant: the page creates an opportunity only, then sends the user to detail to record payment.

**Where:**
- `app/workspace/opportunities/new/_components/create-opportunity-page-client.tsx` (modify)

**How:**

**Step 1: Add `onSubmit`.**

```tsx
// Path: app/workspace/opportunities/new/_components/create-opportunity-page-client.tsx
const onSubmit = async (values: CreateOpportunityFormValues) => {
  setIsSubmitting(true);
  setSubmitError(null);

  try {
    const result = await createManual({
      clientRequestId: requestIdRef.current,
      existingLeadId:
        values.leadMode === "existing"
          ? (values.existingLeadId as Id<"leads">)
          : undefined,
      newLeadInput:
        values.leadMode === "new"
          ? {
              fullName: values.newFullName!.trim(),
              email: values.newEmail!.trim().toLowerCase(),
              phone: values.newPhone?.trim() || undefined,
              socialHandle:
                values.newSocialPlatform && values.newSocialHandle
                  ? {
                      platform: values.newSocialPlatform,
                      handle: values.newSocialHandle.trim(),
                    }
                  : undefined,
            }
          : undefined,
      assignedCloserId:
        values.assignedCloserId ? (values.assignedCloserId as Id<"users">) : undefined,
      notes: values.notes?.trim() || undefined,
    });

    posthog.capture("opportunity_created_manual", {
      opportunity_id: result.opportunityId,
      lead_was_created: result.leadWasCreated,
      created_by_admin: isAdmin,
      assigned_closer_id: values.assignedCloserId ?? null,
    });
    toast.success("Opportunity created");
    requestIdRef.current = crypto.randomUUID();
    router.push(`/workspace/opportunities/${result.opportunityId}`);
  } catch (error) {
    posthog.captureException(error);
    setSubmitError(error instanceof Error ? error.message : "Failed to create opportunity");
    setIsSubmitting(false);
  }
};
```

**Step 2: Ensure repeated submits use one stable request id until success.**

```tsx
// Path: app/workspace/opportunities/new/_components/create-opportunity-page-client.tsx
const requestIdRef = useRef(crypto.randomUUID());

// Only rotate after a successful create. On failure, keep the same id so a
// retry after a network timeout can resolve to the already-created row.
requestIdRef.current = crypto.randomUUID();
```

**Key implementation notes:**
- Do not record payment in this submit handler.
- Keep `isSubmitting` true after success because `router.push` will navigate away.
- On error, do not reset the form. Users should be able to fix one field and retry.
- Use `posthog.captureException` consistently with existing payment form behavior.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/opportunities/new/_components/create-opportunity-page-client.tsx` | Modify | Submit handler, telemetry, toasts, navigation. |

---

### 4E - Deep-Link Prefill and Optional Lead Detail CTA

**Type:** Frontend
**Parallelizable:** Yes after 4B/4C are complete.

**What:** Finalize `?leadId=` prefill and optionally add a "Create opportunity" action on lead detail.

**Why:** Deep links let other CRM surfaces start the side-deal flow without custom route variants.

**Where:**
- `app/workspace/opportunities/new/_components/create-opportunity-page-client.tsx` (modify)
- `app/workspace/leads/[leadId]/_components/lead-detail-page-client.tsx` (modify, optional if product wants the CTA in MVP)

**How:**

**Step 1: Confirm default values use the query param.**

```tsx
// Path: app/workspace/opportunities/new/_components/create-opportunity-page-client.tsx
const searchParams = useSearchParams();
const prefilledLeadId = searchParams.get("leadId") as Id<"leads"> | null;

const form = useForm({
  resolver: standardSchemaResolver(schema),
  defaultValues: {
    leadMode: "existing",
    existingLeadId: prefilledLeadId ?? undefined,
    // ...
  },
});
```

**Step 2: Optional lead detail CTA if scope allows.**

```tsx
// Path: app/workspace/leads/[leadId]/_components/lead-detail-page-client.tsx
<Button asChild size="sm">
  <Link href={`/workspace/opportunities/new?leadId=${lead._id}`}>
    Create opportunity
  </Link>
</Button>
```

**Key implementation notes:**
- The optional lead detail CTA should only be added if the page already has an action area that can accept it cleanly. Do not redesign the lead detail page in this phase.
- If the optional CTA is skipped, deep-link support still ships and the CTA can land in a later polish phase.
- If `leadId` is invalid or out of scope, `LeadCombobox` shows no selected lead and form validation catches the missing lead on submit.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/opportunities/new/_components/create-opportunity-page-client.tsx` | Modify | Confirm `leadId` prefill behavior. |
| `app/workspace/leads/[leadId]/_components/lead-detail-page-client.tsx` | Modify / Optional | Add deep-link CTA if it fits the existing action area. |

---

### 4F - Create Page QA Gate

**Type:** Manual / Frontend
**Parallelizable:** No - runs after the page is fully wired.

**What:** Verify validation, role-specific UI, deep-link behavior, mutation calls, and mobile layout.

**Why:** This page creates real CRM records. Validation and idempotency mistakes have lasting data consequences.

**Where:**
- Terminal
- Local browser
- Convex dashboard

**How:**

**Step 1: Static checks.**

```bash
# Path: repo root
pnpm tsc --noEmit
pnpm lint
```

**Step 2: Browser smoke tests.**

```bash
# Path: repo root
pnpm dev
```

Verify:
- Empty submit shows field-level validation.
- Admin submit without closer shows "Pick an active closer".
- New lead missing email shows the MVP email-required message.
- Existing lead via `?leadId=` renders selected lead label.
- Successful create routes to `/workspace/opportunities/{id}`.
- Back/Cancel returns to `/workspace/opportunities`.
- 390px width has no overlapping radio cards, combobox text, or action buttons.

**Step 3: Data verification.**

```typescript
// Path: Convex dashboard
// Query the created opportunity and confirm:
// source === "side_deal"
// status === "in_progress"
// latestMeetingId === undefined
// nextMeetingId === undefined
// manualCreationKey is set
```

**Key implementation notes:**
- Test both admin and closer accounts; UI role branching is not security, but it must match backend behavior.
- Keep one failed network retry test in the PR notes if practical.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| None | Manual | Verification only. |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `app/workspace/opportunities/new/page.tsx` | Create | 4A |
| `app/workspace/opportunities/new/_components/create-opportunity-skeleton.tsx` | Create | 4A |
| `app/workspace/opportunities/new/_components/create-opportunity-schema.ts` | Create | 4B |
| `app/workspace/opportunities/new/_components/create-opportunity-page-client.tsx` | Create / Modify | 4B, 4D, 4E |
| `app/workspace/opportunities/new/_components/lead-combobox.tsx` | Create | 4C |
| `app/workspace/opportunities/new/_components/closer-select.tsx` | Create | 4C |
| `app/workspace/leads/[leadId]/_components/lead-detail-page-client.tsx` | Modify / Optional | 4E |
