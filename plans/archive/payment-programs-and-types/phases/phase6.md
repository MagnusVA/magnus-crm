# Phase 6 — Settings Programs UI + Shared `ProgramSelect`

**Goal:** Ship the tenant-admin-facing CRUD surface for `tenantPrograms` (`Settings → Programs` tab), plus the shared `ProgramSelect` dropdown that every payment dialog affected by this feature in Phases 7–8 will embed. This is the first frontend phase and it is **gated only on Phase 1** — it does not touch the new `paymentRecords` shape, so it can land while Phases 2–5 are still in review.

Four new files, one file modified:

1. **NEW** `app/workspace/closer/_components/program-select.tsx` — shared select-or-hint component used by `payment-form-dialog`, `reminder-payment-dialog`, `review-resolution-dialog`, and `record-payment-dialog`. Lives under `closer/_components` because the closer workflow is the primary consumer; admin-only dialogs re-import it by path.
2. **NEW** `app/workspace/settings/_components/programs-tab.tsx` — tab container: "New program" button, active-first sorted list, muted "Show archived" toggle, empty state.
3. **NEW** `app/workspace/settings/_components/program-form-dialog.tsx` — RHF + Zod create/edit modal. Externally controlled (open state managed by the parent `programs-tab`). Mirrors `role-edit-dialog.tsx` for the external-control pattern and `field-mapping-dialog.tsx` for the edit-reset `useEffect`.
4. **NEW** `app/workspace/settings/_components/program-row.tsx` — one card per program with name, description, currency chip, archived pill, and an actions `DropdownMenu` (Edit / Archive / Restore).
5. **MODIFIED** `app/workspace/settings/_components/settings-page-client.tsx` — adds a fourth tab `programs` between `field-mappings` and any future tab; drops the `isAdmin === false` redirect since it is already in place.

**Prerequisites:**

- **Phase 1 merged** — `tenantPrograms` table + `api.tenantPrograms.queries.listPrograms` + `api.tenantPrograms.mutations.upsertProgram` / `archiveProgram` / `restoreProgram` are deployed. Without Phase 1, `useQuery(api.tenantPrograms.queries.listPrograms, ...)` throws at mount.
- `internal.tenantPrograms.seed.ensureInitialProgramForTenant` can optionally be invoked by deploy orchestration before this phase ships so the list is non-empty on first open; not a hard blocker because the empty state is graceful.
- AGENTS.md § Form Patterns is followed verbatim — RHF + Zod + `standardSchemaResolver`, co-located schema, `<FormField>` + `<FormMessage>` for inline errors, separate `useState` for dialog open and submit-level errors only.

**Runs in PARALLEL with:**

- **Phase 2** — no shared files. Phase 2 rewrites `paymentRecords`; Phase 6 never touches it.
- **Phase 3** — no shared files. Phase 3 rewrites commissionable payment mutations; Phase 6 only reads programs.
- **Phase 4** — no shared files. Phase 4 touches the meeting / reminder / customer-direct / review payment mutations and the admin reminder detail query.
- **Phase 5** — no shared files. Phase 5 rewrites reporting queries.
- **Phase 7 / 8** — shared `ProgramSelect` component. Phase 6's `6A` must land before the payment-dialog phases can fully test their new `programId` field. We decouple this explicitly: **6A is the first subphase; the other frontend phases can start against the 6A component as soon as it compiles**, even if the rest of Phase 6 (Settings tab) is still open for review.

> **Critical path:** Phase 6 is NOT on the blocking critical path of the backend (Phases 2–5 do not depend on it). It IS on the critical path of Phases 7/8 (they import `ProgramSelect`). Ship 6A first and in isolation; ship 6B–6E in a second batch once QA has signed off on Settings UX. The Settings-tab subphases (6B–6E) can lag by a day without holding up the payment-dialog phases.

**Skills to invoke:**

- `shadcn` — this phase uses existing shadcn primitives (`Card`, `Dialog`, `Form`, `Select`, `DropdownMenu`, `Empty`, `Badge`, `Button`, `Input`, `Textarea`, `Switch`, `Alert`). No new shadcn components need to be added via `npx shadcn@latest add`. Confirm visually that the new components match the existing Settings-tab language.
- `frontend-design` — reference only. Program cards follow the existing `field-mappings-tab.tsx` language (card with title, meta row, right-aligned button). Typography / spacing tokens come from `AGENTS.md § Styling & Theming`.
- `vercel-composition-patterns` — `ProgramSelect` is a three-state component (loading / empty / populated). Rather than branching in the JSX of each caller, the component itself renders the loading hint and the empty message; callers only pass `value` + `onChange`. This is the "render what you know" composition pattern that keeps every payment dialog's JSX identical regardless of program state.
- `web-design-guidelines` — verify: (a) archive action uses `AlertDialog` not plain `Dialog` because it is destructive, (b) empty state uses the shared `<Empty>` primitive with `<EmptyMedia variant="icon">`, (c) every interactive element has an `aria-label`, (d) keyboard: the "New program" button is the first focusable element on the tab so `Tab` from page load lands there.
- `convex-performance-audit` — reference only. Phase 1 already ensured `listPrograms` is bounded (`.take(200)`) and uses a single index (`by_tenantId`). Phase 6 does not add any new Convex calls beyond reading this list and calling three existing mutations.

**Acceptance Criteria:**

1. `app/workspace/closer/_components/program-select.tsx` exports `ProgramSelect` as a `"use client"` component with `{ value, onChange, disabled?, placeholder? }` props. It subscribes to `api.tenantPrograms.queries.listPrograms({ includeArchived: false })` and renders:
   - A muted `Spinner + "Loading programs…"` pill when `programs === undefined`.
   - A muted hint `"No programs configured yet. Ask an admin to add one in Settings → Programs."` when the list is empty.
   - A populated `<Select>` with items sorted alphabetically (the server already returns them pre-sorted) when the list has ≥1 active program. Each `<SelectItem>` uses `program._id` as the key **and** the value; `program.name` is the visible label.
   - `onChange` receives the raw `Id<"tenantPrograms">` string. Callers are responsible for casting to `Id<"tenantPrograms">` when passing to Convex mutations.
2. `settings-page-client.tsx` renders a fourth tab `programs`. The tab is visible only to admins — the existing `isAdmin` gate at the top of the file already enforces this at the page level, so the tab itself does not need a second check. The tab label is `Programs`; its content is `<ProgramsTab />`. Focus order on the tab list is `calendly → event-types → field-mappings → programs`.
3. `<ProgramsTab />` subscribes to `api.tenantPrograms.queries.listPrograms({ includeArchived: showArchived })` where `showArchived` is a local `useState(false)`. The header row renders:
   - A short descriptive paragraph under the tab.
   - A `<Switch>` labelled `"Show archived"` that flips `showArchived`.
   - A primary button `<PlusIcon /> New Program` that opens `<ProgramFormDialog mode="create" />`.
4. `<ProgramsTab />` renders `<Empty>` when the programs list is empty AND `showArchived === false` (initial empty state after tenant provisioning without seed). When archived programs exist but no active programs do, a different empty state displays with a CTA encouraging the admin to either restore one or create a new one. After the admin clicks "New Program" and the mutation resolves, the empty state is replaced by the single card.
5. `<ProgramRow />` receives `{ program, onEdit, onArchive, onRestore }` and renders:
   - Program `name` as the card title; `description` as muted body text (truncated at 2 lines via `line-clamp-2`); a `<Badge variant="outline">` with `defaultCurrency ?? "—"`; a `<Badge variant="secondary">Archived</Badge>` when `program.archivedAt` is set.
   - A `<DropdownMenu>` with items `Edit`, `Archive`, `Restore`. The visible-vs-hidden logic is: `Edit` always visible; `Archive` visible iff `!program.archivedAt`; `Restore` visible iff `!!program.archivedAt`.
   - Archive and restore are routed through a confirmation `<AlertDialog>` to prevent one-click accidents.
6. `<ProgramFormDialog />` supports two modes — `create` (no `program` prop) and `edit` (with `program` prop). Uses RHF + `standardSchemaResolver(programSchema)` with three fields: `name` (required, trimmed, 1–80 chars, unique per tenant), `description` (optional, 0–500 chars), `defaultCurrency` (optional, `"USD" | "EUR" | "GBP" | "CAD" | "AUD"` enum to match the `paymentRecords.currency` dropdown). The `useEffect` reset pattern from `field-mapping-dialog.tsx:133-146` re-seeds the form when `open` flips to true.
7. `<ProgramFormDialog />` calls `api.tenantPrograms.mutations.upsertProgram` with `{ programId: existing?._id, name, description, defaultCurrency }`. Submit-level errors (including the name-clash `"A program named \"X\" already exists."` from Phase 1 §1B) render verbatim in `<Alert variant="destructive">`. On success, the dialog closes, the form resets, `toast.success("Program saved")` fires, and `posthog.capture("program_saved", { mode, has_description, has_default_currency })`.
8. The archive confirm dialog uses `<AlertDialog>` with title `Archive "{name}"?` and description `This program will no longer appear in payment dialogs. Historical payments keep the program name for reporting. You can restore it at any time.`. On confirm, `api.tenantPrograms.mutations.archiveProgram` is called. Errors (including the last-active-program guard `"At least one active program is required. ..."` from Phase 1 §1B) render as `toast.error(error.message)`. On success, `toast.success("Program archived")` fires; the list updates reactively.
9. The restore dialog uses `<AlertDialog>` with title `Restore "{name}"?` and description `This program will re-appear in payment dialogs. If an active program with the same name exists, restore will fail.`. On confirm, `api.tenantPrograms.mutations.restoreProgram` is called; errors (including the name-clash guard from Phase 1 §1B) render via `toast.error`.
10. `pnpm tsc --noEmit` passes with zero errors. No reference to the removed `provider` field anywhere in the new files. No reference to the deprecated `customers.programType` string. All `Id<"tenantPrograms">` casts pass through `as Id<"tenantPrograms">` at the mutation call sites (pattern consistent with `invite-user-dialog.tsx:117`).
11. `pnpm lint` passes. No `eslint-disable` comments added.
12. Smoke test (per `TESTING.MD`): sign in as `tenant_master@seed.dev`, navigate to `/workspace/settings`, click the `Programs` tab. Verify: (a) initial empty state renders, (b) "New Program" opens the dialog, (c) creating `Launchpad` (no description, `USD` currency) results in a single card, (d) creating `launchpad` again throws the duplicate error in `<Alert variant="destructive">`, (e) creating `Accelerator` results in two cards, (f) archiving `Accelerator` triggers the `AlertDialog`, confirms, and shows the card with the `Archived` badge when `Show archived` is on, (g) archiving the last active program (`Launchpad` when `Accelerator` is archived) throws the last-active error toast, (h) restoring `Accelerator` un-pills the badge and returns it to the active list, (i) the shared `ProgramSelect` (reached via `/workspace/closer/meetings/<active-meeting>/` → Log Payment) lists both `Launchpad` and `Accelerator` when both are active, and only `Launchpad` when `Accelerator` is archived.

---

## Subphase Dependency Graph

```
6A (ProgramSelect shared component)
   │
   ├──▶ (Phase 7/8 payment dialogs can start here)
   │
   ▼
6B (program-form-dialog.tsx)  ──┐
                                ├──▶ 6D (programs-tab.tsx, consumes 6B + 6C)
6C (program-row.tsx)  ──────────┘
                                              │
                                              ▼
                                6E (settings-page-client.tsx — wires 6D into the tab list)
```

**Edges explained:**

- **6A first.** The shared dropdown has zero dependencies beyond `listPrograms` (already in Phase 1) and is the unblocker for Phases 7/8. One developer can ship 6A in 20 minutes.
- **6B and 6C are independent.** 6B is the form modal (mutation caller); 6C is the presentational row (calls parent handlers). They can be written in parallel by two developers or back-to-back by one.
- **6D consumes 6B + 6C.** `ProgramsTab` imports both and wires them together. It cannot be written until their props interfaces are stable, but that happens the moment 6B/6C typecheck.
- **6E is trivial.** One import + two JSX additions. Can happen in the same PR as 6D.

**Parallelism window:** 6B + 6C are the true parallel window (two parallel streams possible). Everything else is sequential on paper but any one developer can finish 6B–6E in a single sitting — the gating concern is code review, not compute.

---

## 6A — Shared `ProgramSelect` Component

**Type:** Frontend (`"use client"`)
**Parallelizable:** No — first subphase. Phase 7 and Phase 8 both import this file. Ship it alone, typecheck, then fan out.

**What:** A three-state select component at `app/workspace/closer/_components/program-select.tsx`. Renders a loading pill (`programs === undefined`), an empty-state hint (`programs.length === 0`), or a shadcn `<Select>` bound to the caller's `value` / `onChange`. Returns the `Id<"tenantPrograms">` as a plain string; caller casts at mutation boundary.

**Why:** Four payment dialogs in Phases 7 and 8 (`payment-form-dialog`, `reminder-payment-dialog`, `review-resolution-dialog`, `record-payment-dialog`) all need to pick a program. Without a shared component, each dialog duplicates the loading / empty / populated logic and the call to `useQuery(api.tenantPrograms.queries.listPrograms, ...)`. The shared component owns all three states so each caller's JSX is one `<FormField>` with `<ProgramSelect />` inside `<FormControl>`.

**Location choice — `app/workspace/closer/_components/`:** The closer workflow is the primary consumer (three of four dialogs). Placing it under `closer/_components/` keeps the shared file next to its most common caller. Admin-only consumers (`record-payment-dialog` on the customer detail page) import from the same absolute path — shared components living under the most common domain is the convention already used elsewhere (e.g., `app/workspace/closer/_components/meeting-status-badge.tsx` is imported by admin pipeline views in Phase 9).

**Where:**
- `app/workspace/closer/_components/program-select.tsx` (new)

**How:**

**Step 1: Create the file**

```tsx
// Path: app/workspace/closer/_components/program-select.tsx
"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

type ProgramSelectProps = {
  /** Current selection, or undefined for "not yet chosen". */
  value: string | undefined;
  /** Called with the raw tenantPrograms Id string. Caller casts to Id<"tenantPrograms">. */
  onChange: (value: string) => void;
  /** Disable the entire control (submit in flight, etc.). */
  disabled?: boolean;
  /** Override the default placeholder. */
  placeholder?: string;
  /** Additional CSS classes for the outer wrapper. */
  className?: string;
};

/**
 * Shared tenant-program dropdown used by every commissionable and
 * customer-direct payment dialog. Owns three states so callers never
 * branch on loading/empty.
 */
export function ProgramSelect({
  value,
  onChange,
  disabled,
  placeholder,
  className,
}: ProgramSelectProps) {
  const programs = useQuery(api.tenantPrograms.queries.listPrograms, {
    includeArchived: false,
  });

  if (programs === undefined) {
    return (
      <div
        className={cn(
          "flex h-9 items-center gap-2 rounded-md border border-input bg-transparent px-3 text-sm text-muted-foreground",
          className,
        )}
        role="status"
        aria-label="Loading programs"
      >
        <Spinner className="size-3" />
        <span>Loading programs…</span>
      </div>
    );
  }

  if (programs.length === 0) {
    return (
      <p
        className={cn("text-xs text-muted-foreground", className)}
        role="alert"
      >
        No programs configured yet. Ask an admin to add one in{" "}
        <strong>Settings → Programs</strong>.
      </p>
    );
  }

  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className={className} aria-label="Select program">
        <SelectValue placeholder={placeholder ?? "Select a program"} />
      </SelectTrigger>
      <SelectContent>
        {programs.map((program) => (
          <SelectItem key={program._id} value={program._id}>
            {program.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
```

**Step 2: Sanity-check the import path**

Run a quick grep from the repo root to confirm no existing file sits at the target path:

```bash
ls app/workspace/closer/_components/ | grep program-select.tsx
```

Should return empty before creation, non-empty after.

**Step 3: Typecheck**

```bash
pnpm tsc --noEmit
```

Must pass with zero errors. The file imports three symbols from Convex (`useQuery`, `api`), four from shadcn Select, one from Spinner, one from `cn`. No `Id` cast is needed inside this file — the generic prop is `string` on both sides.

**Key implementation notes:**
- **Why `string | undefined` on `value`** rather than `Id<"tenantPrograms"> | undefined`: RHF field values are always plain strings (the form stores the selected ID as a string in `defaultValues`). Exposing the typed `Id` here would force every caller to import `Id<"tenantPrograms">` just to satisfy the prop type. We keep the generic string interface and let the caller cast once, at the mutation boundary, where the typesafety actually matters.
- **Why not a `loading` / `empty` prop callback**: the three states are the same for every caller in this codebase. Accepting a `renderLoading` / `renderEmpty` slot prop would add four paths of branching with no consumer ever overriding them. YAGNI — if a future caller needs a different loading message, we add the slot prop then, not now.
- **`placeholder` prop**: defaults to `"Select a program"`. The customer-detail dialog uses `"Select program (defaults to customer's program)"` when the customer has a linked program; the override flows through this prop.
- **`role="status"` on the loading pill + `role="alert"` on the empty hint**: screen readers announce the state changes. Without these, a blind user tabs into the form field and hears nothing because the visual pill is not a `<select>`.
- **`cn` + `className` prop**: lets callers extend the outer wrapper with their own Tailwind classes (`w-full`, `mt-2`, etc.) without fighting the component's defaults. Consistent with `FormControl`'s composition.
- **No `posthog.capture` here.** Analytics fire at the submit site (dialog) where the final selection and the rest of the form payload are known. Emitting a change event on every dropdown interaction creates noise.

**Verification checklist:**

- [ ] `pnpm tsc --noEmit` passes.
- [ ] The loading pill width matches a standard 9-row `h-9` select so layout does not reflow when `programs` arrives.
- [ ] Manually open `/workspace/settings` → Programs, create `Launchpad`, then navigate to `/workspace/closer/meetings/<id>` → Log Payment (Phase 7 still uses old Fathom-link shape pre-merge, but the shared component renders as a standalone field when injected). Confirm the dropdown shows `Launchpad`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/_components/program-select.tsx` | Create | Shared dropdown, three states. |

---

## 6B — `program-form-dialog.tsx` (RHF + Zod create / edit modal)

**Type:** Frontend
**Parallelizable:** Yes — can run alongside 6C.

**What:** A `"use client"` modal dialog at `app/workspace/settings/_components/program-form-dialog.tsx`. Externally controlled (parent owns `open` state). Supports two modes: `create` (blank defaults) and `edit` (hydrated from a `program` prop). Submits to `api.tenantPrograms.mutations.upsertProgram`.

**Why:** Admin needs a focused create/edit surface. Using a single dialog for both modes mirrors `upsertProgram` on the server (which is one mutation with optional `programId`) and `upsertEventTypeConfig` precedent in `event-type-config-dialog.tsx`. The externally controlled pattern (vs. a `<DialogTrigger>`-wrapped button) lets the parent `programs-tab` own the "which row is being edited" state, which is simpler than threading the selection through the dialog.

**Where:**
- `app/workspace/settings/_components/program-form-dialog.tsx` (new)

**How:**

**Step 1: Co-locate the Zod schema**

```tsx
// Path: app/workspace/settings/_components/program-form-dialog.tsx
"use client";

import { useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { toast } from "sonner";
import posthog from "posthog-js";

// -----------------------------------------------------------------------------
// Zod schema — co-located per AGENTS.md § Form Patterns.
// -----------------------------------------------------------------------------

// Sentinel for the "no default currency" option (Radix Select cannot use "").
const NONE_CURRENCY = "__none__";

// Mirrors the currency list used by paymentRecords elsewhere in the codebase.
// Keep in sync with the Currency picker inside payment-form-dialog (Phase 7).
const CURRENCY_OPTIONS = [
  { value: "USD", label: "USD — US Dollar" },
  { value: "EUR", label: "EUR — Euro" },
  { value: "GBP", label: "GBP — Pound Sterling" },
  { value: "CAD", label: "CAD — Canadian Dollar" },
  { value: "AUD", label: "AUD — Australian Dollar" },
] as const;

const programSchema = z.object({
  name: z
    .string()
    .min(1, "Program name is required")
    .max(80, "Program name must be 80 characters or fewer")
    .refine(
      (value) => value.trim().length > 0,
      "Program name cannot be whitespace only",
    ),
  description: z
    .string()
    .max(500, "Description must be 500 characters or fewer")
    .optional()
    .or(z.literal("")),
  defaultCurrency: z.string(), // NONE_CURRENCY sentinel or a CURRENCY_OPTIONS value
});

type ProgramFormValues = z.infer<typeof programSchema>;
```

**Step 2: Define props + component signature**

```tsx
interface ProgramFormDialogProps {
  /** Controlled open state — parent owns this. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When provided, the dialog opens in EDIT mode seeded from this program. */
  program?: Doc<"tenantPrograms">;
  /** Called after a successful upsert — parent may close the dialog or refetch. */
  onSuccess?: () => void;
}

export function ProgramFormDialog({
  open,
  onOpenChange,
  program,
  onSuccess,
}: ProgramFormDialogProps) {
  const mode: "create" | "edit" = program ? "edit" : "create";
  const [submitError, setSubmitError] = useState<string | null>(null);

  const upsertProgram = useMutation(
    api.tenantPrograms.mutations.upsertProgram,
  );

  // Do NOT pass an explicit generic — let the resolver infer the types
  // (per AGENTS.md § Form Patterns).
  const form = useForm({
    resolver: standardSchemaResolver(programSchema),
    defaultValues: {
      name: program?.name ?? "",
      description: program?.description ?? "",
      defaultCurrency: program?.defaultCurrency ?? NONE_CURRENCY,
    },
  });

  // Externally controlled dialog — reset the form whenever it re-opens so
  // the fields always match the currently-targeted `program` prop
  // (same pattern as field-mapping-dialog.tsx:133-146).
  useEffect(() => {
    if (open) {
      form.reset({
        name: program?.name ?? "",
        description: program?.description ?? "",
        defaultCurrency: program?.defaultCurrency ?? NONE_CURRENCY,
      });
      setSubmitError(null);
    }
  }, [open, program, form]);

  const isSubmitting = form.formState.isSubmitting;
```

**Step 3: Write the submit handler**

```tsx
  const onSubmit = async (values: ProgramFormValues) => {
    setSubmitError(null);

    // Convert the NONE sentinel back to undefined before the mutation call.
    const defaultCurrency =
      values.defaultCurrency !== NONE_CURRENCY
        ? values.defaultCurrency
        : undefined;
    const description =
      values.description && values.description.trim().length > 0
        ? values.description.trim()
        : undefined;

    try {
      await upsertProgram({
        programId: program?._id,
        name: values.name.trim(),
        description,
        defaultCurrency,
      });

      posthog.capture("program_saved", {
        mode,
        has_description: !!description,
        has_default_currency: !!defaultCurrency,
      });

      toast.success(
        mode === "create" ? "Program created" : "Program updated",
      );
      onOpenChange(false);
      onSuccess?.();
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to save program";
      setSubmitError(message);
      posthog.captureException(error);
    }
  };
```

**Step 4: Write the JSX**

```tsx
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isSubmitting) {
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {mode === "create" ? "New Program" : "Edit Program"}
          </DialogTitle>
          <DialogDescription>
            {mode === "create"
              ? "Programs group customers and payments for reporting. They appear in every payment dialog."
              : "Renaming a program updates historical payments and customer records automatically."}
          </DialogDescription>
        </DialogHeader>

        {submitError && (
          <Alert variant="destructive">
            <AlertDescription>{submitError}</AlertDescription>
          </Alert>
        )}

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="flex flex-col gap-6"
          >
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Name <span className="text-destructive">*</span>
                  </FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. Launchpad, Accelerator"
                      disabled={isSubmitting}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    Shown in payment dialogs and reports. Must be unique per
                    tenant.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={3}
                      placeholder="Optional — visible only in Settings"
                      disabled={isSubmitting}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="defaultCurrency"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Default Currency</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={field.onChange}
                    disabled={isSubmitting}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="None" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={NONE_CURRENCY}>
                        None (closer chooses per payment)
                      </SelectItem>
                      {CURRENCY_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    Pre-fills the currency in payment dialogs for this program.
                    Closers can still override on a per-payment basis.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting && <Spinner data-icon="inline-start" />}
                {isSubmitting
                  ? mode === "create"
                    ? "Creating…"
                    : "Saving…"
                  : mode === "create"
                    ? "Create Program"
                    : "Save Changes"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
```

**Step 5: Typecheck + lint**

```bash
pnpm tsc --noEmit
pnpm lint
```

Both must pass. `Doc<"tenantPrograms">` resolves to the row shape defined in Phase 1's schema; `Id<"tenantPrograms">` is not imported here because the server mutation accepts `programId: v.optional(v.id("tenantPrograms"))` and the type flows through `api.tenantPrograms.mutations.upsertProgram`'s generated signature.

**Key implementation notes:**
- **`.or(z.literal(""))` on `description`**: allows an empty string to pass the schema; the submit handler then trims and converts to `undefined`. This is the idiomatic way to make `string | undefined` work with `<Textarea>` whose `value` is always a string.
- **`NONE_CURRENCY` sentinel**: Radix `<Select>` cannot use an empty string as a value. The sentinel pattern matches `field-mapping-dialog.tsx:41`.
- **Why the `<Alert variant="destructive">` for submit-level errors AND a `toast.error` inside the handler**: we only use the Alert for submit-level errors (the clash message from `upsertProgram`). The `toast.error` appears exclusively in the archive / restore paths (6C). This separation mirrors the AGENTS.md guidance — validation errors go inline (`<FormMessage />`), submit-level errors go in the banner Alert within the dialog.
- **`onOpenChange` guard**: prevents closing the dialog by clicking outside or pressing Esc while a mutation is in flight. Consistent with the pattern in `invite-user-dialog.tsx:142-149`.
- **`posthog.capture("program_saved", …)`**: single event name for both create and edit, differentiated by `mode`. This makes funnel analysis (`program_saved` events per tenant per week) easier than two separate events.
- **No explicit `<DialogTrigger>`**: the dialog is externally controlled. The parent `<ProgramsTab>` renders its own "New Program" / "Edit" buttons and flips `open` state.
- **`mode` discriminator**: derived from `!!program` rather than accepted as a separate prop. Keeps the prop surface minimal and guarantees that `edit` mode always has a `program` to render.
- **Button copy: `"Create Program"` vs `"Save Changes"`**: matches the shadcn / AGENTS.md pattern of using verb-object copy (not generic "Submit"). The submitting state uses `"Creating…"` / `"Saving…"` with an ellipsis to signal async.

**Verification checklist:**

- [ ] Open the dialog in create mode, type nothing, press Create. `FormMessage` shows `"Program name is required"`.
- [ ] Type 81 characters. `FormMessage` shows the max-length error.
- [ ] Type `Launchpad` when another active `Launchpad` exists. The submit `Alert` shows `"A program named \"Launchpad\" already exists."`.
- [ ] Open in edit mode, change the name to match another active program. Same error in Alert.
- [ ] Open in edit mode, cancel without changes. Form state does not leak to the next open.
- [ ] Open in edit mode on the same row twice in a row with different field edits. The second open resets to the canonical row (the `useEffect` runs).
- [ ] Network-disconnect mid-submit → the catch branch shows a friendly error string, not `[object Object]`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/settings/_components/program-form-dialog.tsx` | Create | RHF + Zod, externally controlled. |

---

## 6C — `program-row.tsx` (list row with action menu)

**Type:** Frontend (`"use client"`)
**Parallelizable:** Yes — runs alongside 6B.

**What:** A purely presentational row component at `app/workspace/settings/_components/program-row.tsx`. Receives `{ program, onEdit, onArchive, onRestore }` and renders a `<Card>` with program metadata and an actions `<DropdownMenu>`. The archive / restore confirmation `<AlertDialog>`s live inside this row component to keep the trigger and the confirmation co-located.

**Why:** Breaking the list item out from `ProgramsTab` keeps the tab component small and makes testing the visual shape of a row simple. Mirrors `field-mappings-tab.tsx` where the row JSX is inlined — but we pull it out here because the row has destructive actions (archive / restore) that each need their own confirm dialog; inlining makes the tab file bulge.

**Where:**
- `app/workspace/settings/_components/program-row.tsx` (new)

**How:**

**Step 1: Type the component signature**

```tsx
// Path: app/workspace/settings/_components/program-row.tsx
"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Spinner } from "@/components/ui/spinner";
import {
  EllipsisVerticalIcon,
  PencilIcon,
  ArchiveIcon,
  ArchiveRestoreIcon,
} from "lucide-react";
import { toast } from "sonner";
import posthog from "posthog-js";
import { cn } from "@/lib/utils";

interface ProgramRowProps {
  program: Doc<"tenantPrograms">;
  onEdit: (program: Doc<"tenantPrograms">) => void;
}
```

**Step 2: Component body + confirm dialog state**

```tsx
type PendingAction = null | "archive" | "restore";

export function ProgramRow({ program, onEdit }: ProgramRowProps) {
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const archiveProgram = useMutation(
    api.tenantPrograms.mutations.archiveProgram,
  );
  const restoreProgram = useMutation(
    api.tenantPrograms.mutations.restoreProgram,
  );

  const isArchived = !!program.archivedAt;

  const handleConfirm = async () => {
    if (!pendingAction) return;
    setIsSubmitting(true);
    try {
      if (pendingAction === "archive") {
        await archiveProgram({ programId: program._id });
        posthog.capture("program_archived", { programId: program._id });
        toast.success(`"${program.name}" archived`);
      } else {
        await restoreProgram({ programId: program._id });
        posthog.capture("program_restored", { programId: program._id });
        toast.success(`"${program.name}" restored`);
      }
      setPendingAction(null);
    } catch (error) {
      posthog.captureException(error);
      toast.error(
        error instanceof Error
          ? error.message
          : pendingAction === "archive"
            ? "Failed to archive program"
            : "Failed to restore program",
      );
    } finally {
      setIsSubmitting(false);
    }
  };
```

**Step 3: Row JSX**

```tsx
  return (
    <>
      <Card className={cn(isArchived && "opacity-70")}>
        <CardContent className="flex items-start justify-between gap-4 py-4">
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <p className="truncate font-medium">{program.name}</p>
              {isArchived && (
                <Badge variant="secondary" className="shrink-0">
                  Archived
                </Badge>
              )}
              <Badge variant="outline" className="shrink-0">
                {program.defaultCurrency ?? "No default currency"}
              </Badge>
            </div>
            {program.description && (
              <p className="line-clamp-2 text-sm text-muted-foreground">
                {program.description}
              </p>
            )}
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Actions for ${program.name}`}
              >
                <EllipsisVerticalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onEdit(program)}>
                <PencilIcon data-icon="inline-start" />
                Edit
              </DropdownMenuItem>
              {!isArchived && (
                <DropdownMenuItem
                  onClick={() => setPendingAction("archive")}
                  variant="destructive"
                >
                  <ArchiveIcon data-icon="inline-start" />
                  Archive
                </DropdownMenuItem>
              )}
              {isArchived && (
                <DropdownMenuItem
                  onClick={() => setPendingAction("restore")}
                >
                  <ArchiveRestoreIcon data-icon="inline-start" />
                  Restore
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </CardContent>
      </Card>

      <AlertDialog
        open={pendingAction !== null}
        onOpenChange={(next) => {
          if (!next && !isSubmitting) setPendingAction(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingAction === "archive"
                ? `Archive "${program.name}"?`
                : `Restore "${program.name}"?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingAction === "archive"
                ? "This program will no longer appear in payment dialogs. Historical payments keep the program name for reporting. You can restore it at any time."
                : "This program will re-appear in payment dialogs. If an active program with the same name exists, restore will fail."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSubmitting}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault(); // we handle the close ourselves
                void handleConfirm();
              }}
              disabled={isSubmitting}
              className={cn(
                pendingAction === "archive" &&
                  "bg-destructive text-destructive-foreground hover:bg-destructive/90",
              )}
            >
              {isSubmitting && <Spinner data-icon="inline-start" />}
              {pendingAction === "archive" ? "Archive" : "Restore"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
```

**Step 4: Typecheck + lint**

```bash
pnpm tsc --noEmit
pnpm lint
```

**Key implementation notes:**
- **`onEdit` hoisted to parent**: the row receives an `onEdit` callback, not an internal dialog. This lets the parent `<ProgramsTab>` own the `editingProgram` selection state, which is cleaner than scattering state across N rows.
- **`AlertDialog` inside the row**: archive / restore confirmations stay local to the row because the confirmation content references the specific program's name. Hoisting to the parent would force threading the pending program through another layer of state.
- **`pendingAction` state machine**: `null | "archive" | "restore"`. One state variable, two entry paths, one exit path via `setPendingAction(null)`. No `isArchiveDialogOpen` / `isRestoreDialogOpen` twin booleans — that shape invites the impossible `both-true` state.
- **`event.preventDefault()` on `AlertDialogAction`**: by default shadcn's action auto-closes the AlertDialog. We want to keep it open until the mutation resolves (so the Spinner is visible and errors appear in the toast) and then close it manually via `setPendingAction(null)`. This is the same pattern as the existing `remove-user-dialog.tsx`.
- **`variant="destructive"` on the Archive menu item**: shadcn's DropdownMenuItem has a destructive variant that uses the theme's destructive color token. Restore is a safe action so it uses the default variant.
- **Error messages from the server are shown verbatim**: the last-active-program guard (`"At least one active program is required. ..."`) and the restore name-clash guard are server-defined strings — the frontend passes them through unchanged. No remapping layer.
- **`posthog.capture("program_archived"` / `"program_restored"`)**: two separate events so funnels can count each distinct intent. Both include the `programId` for join queries against the Convex table.
- **Focus management**: `DropdownMenuTrigger asChild` keeps the button's `aria-label` on the real button. When the AlertDialog opens, Radix automatically moves focus to the cancel button. On close, focus returns to the trigger.
- **`opacity-70` on archived rows**: subtle visual deprioritization without hiding the row entirely; consistent with how archived items render in other parts of the app.

**Verification checklist:**

- [ ] Click `⋮ → Archive` on an active row → AlertDialog opens with the destructive title.
- [ ] Click Cancel on the AlertDialog → dialog closes, no mutation call, no toast.
- [ ] Click Archive on the AlertDialog (with 1 active program remaining) → server throws; `toast.error` shows the last-active message; AlertDialog stays open so the user can cancel cleanly.
- [ ] Click `⋮ → Restore` on an archived row → AlertDialog opens with the non-destructive title.
- [ ] Keyboard-tab from the trigger to the dropdown, arrow through items, press Enter on Archive → dialog opens. Keyboard-only flow is intact.
- [ ] `aria-label` on the trigger reads "Actions for Launchpad" (or whatever the program name is).
- [ ] On a row with `defaultCurrency === undefined`, the outline badge reads "No default currency" (no broken empty badge).
- [ ] On a row with a 600-character description, the card truncates at 2 lines (`line-clamp-2`).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/settings/_components/program-row.tsx` | Create | Card row + local AlertDialog for archive/restore. |

---

## 6D — `programs-tab.tsx` (tab container)

**Type:** Frontend (`"use client"`)
**Parallelizable:** No — consumes 6B and 6C.

**What:** The tab-content container at `app/workspace/settings/_components/programs-tab.tsx`. Subscribes to `listPrograms({ includeArchived })`, renders a header row (description + `Show archived` switch + `New Program` button), the empty state, or the `<ProgramRow>` list.

**Why:** The Settings tab is where all the Programs UX flows bind together. It owns the `editingProgram` state (which row is in edit mode), the `showArchived` toggle, and the create-dialog open state.

**Where:**
- `app/workspace/settings/_components/programs-tab.tsx` (new)

**How:**

**Step 1: Imports + component shell**

```tsx
// Path: app/workspace/settings/_components/programs-tab.tsx
"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import dynamic from "next/dynamic";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { LayersIcon, PlusIcon } from "lucide-react";

import { ProgramRow } from "./program-row";

// Lazy-load the form dialog — only rendered on user interaction.
const ProgramFormDialog = dynamic(() =>
  import("./program-form-dialog").then((m) => ({
    default: m.ProgramFormDialog,
  })),
);
```

**Step 2: State + fetch**

```tsx
export function ProgramsTab() {
  const [showArchived, setShowArchived] = useState(false);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingProgram, setEditingProgram] = useState<
    Doc<"tenantPrograms"> | null
  >(null);

  const programs = useQuery(api.tenantPrograms.queries.listPrograms, {
    includeArchived: showArchived,
  });
```

**Step 3: Derived view-model + empty-state branches**

```tsx
  // The server pre-sorts (active first, then archived, alphabetical within each).
  // We split once so the empty-state logic is readable.
  const activeCount =
    programs?.filter((program) => !program.archivedAt).length ?? 0;
  const archivedCount =
    programs?.filter((program) => !!program.archivedAt).length ?? 0;

  const isLoading = programs === undefined;
  const hasAnyProgram = !isLoading && programs!.length > 0;
  const hasOnlyArchived = hasAnyProgram && activeCount === 0;
```

**Step 4: Header row**

```tsx
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1">
          <p className="text-sm text-muted-foreground">
            Programs group customers and payments for reporting. Renaming a
            program updates historical records automatically; archiving hides
            it from payment dialogs but keeps history intact.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Switch
              id="show-archived"
              checked={showArchived}
              onCheckedChange={setShowArchived}
            />
            <Label htmlFor="show-archived" className="text-sm">
              Show archived
            </Label>
          </div>
          <Button onClick={() => setIsCreateOpen(true)}>
            <PlusIcon data-icon="inline-start" />
            New Program
          </Button>
        </div>
      </div>
```

**Step 5: Loading + empty + populated branches**

```tsx
      {isLoading && (
        <div className="flex flex-col gap-3" aria-label="Loading programs">
          {Array.from({ length: 2 }).map((_, index) => (
            <Skeleton key={index} className="h-20 w-full rounded-xl" />
          ))}
        </div>
      )}

      {!isLoading && !hasAnyProgram && (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LayersIcon />
            </EmptyMedia>
            <EmptyTitle>No programs yet</EmptyTitle>
            <EmptyDescription>
              Create your first program so closers can attach it to payments.
              Programs appear in every payment dialog across the CRM.
            </EmptyDescription>
          </EmptyHeader>
          <Button onClick={() => setIsCreateOpen(true)}>
            <PlusIcon data-icon="inline-start" />
            New Program
          </Button>
        </Empty>
      )}

      {!isLoading && hasOnlyArchived && (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LayersIcon />
            </EmptyMedia>
            <EmptyTitle>All programs are archived</EmptyTitle>
            <EmptyDescription>
              Payment dialogs will block submissions until at least one active
              program exists. Restore an archived program or create a new one
              to unblock closers.
            </EmptyDescription>
          </EmptyHeader>
          <Button onClick={() => setIsCreateOpen(true)}>
            <PlusIcon data-icon="inline-start" />
            New Program
          </Button>
        </Empty>
      )}

      {!isLoading && hasAnyProgram && !hasOnlyArchived && (
        <div className="flex flex-col gap-3">
          {programs!.map((program) => (
            <ProgramRow
              key={program._id}
              program={program}
              onEdit={setEditingProgram}
            />
          ))}
          {!showArchived && archivedCount > 0 && (
            <p className="text-center text-xs text-muted-foreground">
              {archivedCount}{" "}
              {archivedCount === 1 ? "program is" : "programs are"} archived.
              Toggle "Show archived" to view them.
            </p>
          )}
        </div>
      )}
```

**Step 6: Dialogs**

```tsx
      {isCreateOpen && (
        <ProgramFormDialog
          open={isCreateOpen}
          onOpenChange={setIsCreateOpen}
        />
      )}

      {editingProgram && (
        <ProgramFormDialog
          open={!!editingProgram}
          onOpenChange={(next) => {
            if (!next) setEditingProgram(null);
          }}
          program={editingProgram}
        />
      )}
    </div>
  );
}
```

**Step 7: Typecheck + lint**

```bash
pnpm tsc --noEmit
pnpm lint
```

**Key implementation notes:**
- **`dynamic(...)` for `ProgramFormDialog`**: the dialog bundle is deferred until the admin clicks "New Program" / "Edit". Consistent with `field-mappings-tab.tsx:20-24`.
- **`Empty` primitive** handles the two empty states. The "all archived" state is *different* from the zero-programs state because the latter is a first-run-experience event and the former is a "you archived everything" event with distinct copy.
- **Note about the "at least one active program" invariant**: Phase 1's `archiveProgram` server-side guard already prevents archiving the *last* active program, so the `hasOnlyArchived` state should only be reachable by: (a) admin-deletes-via-Convex-CLI, (b) future out-of-band bulk-import tooling, or (c) a bug. The UI shows it anyway so the tenant has a clear path forward if the impossible happens.
- **`archivedCount` footer hint**: visible only when `showArchived === false` AND there are archived programs hidden. Nudges the admin toward the toggle without cluttering the active list.
- **`editingProgram` state is the full `Doc<"tenantPrograms">`, not just an `Id`**: we already have the row in memory from the `listPrograms` query — passing the whole object means the dialog does not re-query on open and the `useEffect` reset runs against the canonical data immediately. No flash of empty form.
- **Why the dialog is rendered conditionally (`isCreateOpen && <...>`) instead of always-mounted with a controlled `open` prop**: the externally-controlled dialog pattern works either way; we choose conditional-render so `dynamic(...)` has something to defer. If the dialog is always mounted, the chunk loads on tab open even if the admin never clicks New.
- **`PlusIcon data-icon="inline-start"`**: the AGENTS.md convention for icon placement inside a button, same as the pattern used in `invite-user-dialog.tsx:153`.
- **Accessibility**: the `Show archived` switch uses a `<Label htmlFor="show-archived">` for click-target expansion, consistent with every other switch in the codebase.

**Verification checklist:**

- [ ] First visit with zero programs → first empty state renders; focus order is: Show archived switch → New Program (top) → New Program (in empty card).
- [ ] Create one program → empty state replaced by the single row; the row is focusable; the action menu works.
- [ ] Toggle `Show archived` with only active programs → no change in the list, no archived-count footer (because 0 archived).
- [ ] Archive a program (leaving one active) → list updates reactively without a re-fetch indicator; the `archivedCount` footer appears when `showArchived === false`.
- [ ] Toggle `Show archived` on → archived row appears, opacity 70%, `Archived` badge visible.
- [ ] Open Edit dialog → form hydrates with the archived row's fields; the admin renames it and saves; the row updates.
- [ ] Open Edit dialog, close without submit → opening it again on the same row shows the correct (current) values, not stale.
- [ ] Archive the last active program via the Convex CLI (bypassing the UI guard) → the tab re-renders with the "All programs are archived" empty state.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/settings/_components/programs-tab.tsx` | Create | Tab container, owns list + dialog state. |

---

## 6E — Wire `ProgramsTab` into `settings-page-client.tsx`

**Type:** Frontend
**Parallelizable:** No — trivial import + JSX addition; same PR as 6D.

**What:** Modify `app/workspace/settings/_components/settings-page-client.tsx` to add a fourth tab `programs` and render `<ProgramsTab />`.

**Why:** `SettingsPage` is the static RSC wrapper (`app/workspace/settings/page.tsx:1-7`). All the tab logic lives in the client component. This is a three-line diff but it completes the user-visible surface.

**Where:**
- `app/workspace/settings/_components/settings-page-client.tsx` (modified)

**How:**

**Before (current state):**

```tsx
// Path: app/workspace/settings/_components/settings-page-client.tsx (partial, lines 48-75)
<Tabs defaultValue="calendly" className="w-full">
  <TabsList>
    <TabsTrigger value="calendly">Calendly</TabsTrigger>
    <TabsTrigger value="event-types">Event Types</TabsTrigger>
    <TabsTrigger value="field-mappings">Field Mappings</TabsTrigger>
  </TabsList>

  <TabsContent value="calendly" className="mt-6">
    <CalendlyConnection connectionStatus={connectionStatus} />
  </TabsContent>

  <TabsContent value="event-types" className="mt-6">
    <EventTypeConfigList configs={eventTypeConfigs} />
  </TabsContent>

  <TabsContent value="field-mappings" className="mt-6">
    <FieldMappingsTab configs={configsWithStats} />
  </TabsContent>
</Tabs>
```

**After (modified):**

```tsx
// Path: app/workspace/settings/_components/settings-page-client.tsx (partial, modified)
import { CalendlyConnection } from "./calendly-connection";
import { EventTypeConfigList } from "./event-type-config-list";
import { FieldMappingsTab } from "./field-mappings-tab";
import { ProgramsTab } from "./programs-tab"; // NEW

// ... (isAdmin gate + queries unchanged)

<Tabs defaultValue="calendly" className="w-full">
  <TabsList>
    <TabsTrigger value="calendly">Calendly</TabsTrigger>
    <TabsTrigger value="event-types">Event Types</TabsTrigger>
    <TabsTrigger value="field-mappings">Field Mappings</TabsTrigger>
    <TabsTrigger value="programs">Programs</TabsTrigger>{/* NEW */}
  </TabsList>

  <TabsContent value="calendly" className="mt-6">
    <CalendlyConnection connectionStatus={connectionStatus} />
  </TabsContent>

  <TabsContent value="event-types" className="mt-6">
    <EventTypeConfigList configs={eventTypeConfigs} />
  </TabsContent>

  <TabsContent value="field-mappings" className="mt-6">
    <FieldMappingsTab configs={configsWithStats} />
  </TabsContent>

  <TabsContent value="programs" className="mt-6">{/* NEW */}
    <ProgramsTab />
  </TabsContent>
</Tabs>
```

**Key implementation notes:**
- **No prop passing to `<ProgramsTab />`**: the tab component owns its own `listPrograms` subscription. It does not need data from the parent.
- **`defaultValue="calendly"` stays**: we don't default-open Programs because Calendly is the primary admin-onboarding surface. A future enhancement might persist the last-opened tab to `localStorage`; out of scope for this phase.
- **Tab order chosen deliberately**: calendly → event-types → field-mappings → programs mirrors the mental model of the admin onboarding flow (connect Calendly → configure event types → map booking fields → configure programs).
- **`isAdmin` redirect stays at the top of the file (lines 33-37)**: the Programs tab does not need its own inline gate because the whole page already redirects non-admins to `/workspace/closer`.
- **No loading-state changes needed in `SettingsLoading` (`app/workspace/settings/loading.tsx`)**: the existing generic shell skeleton covers the page-level load. The tab itself renders its own skeleton inside `ProgramsTab` while `listPrograms` is pending.

**Verification checklist:**

- [ ] Sign in as `tenant_master@seed.dev` → navigate to `/workspace/settings` → all four tabs render, Programs is rightmost.
- [ ] Click Programs → loading skeleton shows briefly, then the empty state (first run) or the list.
- [ ] Click other tabs → Calendly / Event Types / Field Mappings still work; no regression from the diff.
- [ ] Sign in as a non-admin (closer) → redirected to `/workspace/closer` before any tabs render.
- [ ] Keyboard: focus enters Calendly trigger on tab-key, arrow-right cycles through tabs including Programs.
- [ ] The browser tab title remains "Settings" (set by `usePageTitle("Settings")`).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/settings/_components/settings-page-client.tsx` | Modify | +1 import, +1 `<TabsTrigger>`, +1 `<TabsContent>`. |

---

## Rollout Order & Ship Checklist

**Ship 6A first, in its own PR.** This unblocks Phase 7 (payment-form-dialog, reminder-payment-dialog) and Phase 8 (record-payment-dialog, review-resolution-dialog) so those teams can build against a real `<ProgramSelect>`. No user-visible change from 6A alone — the component is created but not yet called from any live surface.

**Ship 6B + 6C + 6D + 6E in a second PR.** These four together complete the user-visible Settings Programs surface. A single PR is easier to review as one cohesive feature and a single cohesive QA pass.

**Deploy the Phase 1 seed mutation before the second PR merges.** If `ensureInitialProgramForTenant` has not been invoked for every active tenant, the Programs tab shows the empty state — which is not wrong, just not ideal. Deploy orchestration should:

1. Push Phase 1 Convex code (if not already).
2. Invoke `internal.tenantPrograms.seed.ensureInitialProgramForTenant({ tenantId, name: "Launchpad" })` for each active tenant.
3. Merge and deploy the Phase 6 second PR.

If the seed step is skipped, the admin's first action post-deploy is "create a program", which is the intended fallback.

**Rollback plan.** Phase 6 is frontend-only and does not migrate any data. If the Settings tab surfaces a bug post-deploy:

- Revert the Phase 6 commit on the frontend branch.
- Vercel re-promotes the previous build.
- The `tenantPrograms` rows created during the canary window remain intact (they are not orphaned because Phase 1 owns the table).
- The shared `ProgramSelect` is still used by Phases 7/8; if 6A also rolled back, Phases 7/8 must either revert or fall back to the pre-program `provider` field until 6A is re-landed. In practice, since Phase 7 will not have shipped yet, reverting 6A is fine.

---

## Smoke Test Script (manual QA per `TESTING.MD`)

**Prerequisites:**

- Phase 1 merged and deployed to Convex.
- Optional: `internal.tenantPrograms.seed.ensureInitialProgramForTenant` has NOT been run for this tenant so we get the true first-run experience.

**Test flow:**

1. Sign in at `/sign-in` as `tenant_master@seed.dev` (see `TESTING.MD` for credentials).
2. Navigate to `/workspace/settings`.
3. Verify the tab list shows four tabs: `Calendly`, `Event Types`, `Field Mappings`, `Programs`. Click `Programs`.
4. Verify the empty state renders (`"No programs yet"`), the `Show archived` switch is off, and the `New Program` button appears both in the header and inside the empty card.
5. Click `New Program` in the header.
6. Verify the dialog opens with title `"New Program"` and an empty form.
7. Click `Create Program` without typing anything. Verify `"Program name is required"` appears inline under the Name field.
8. Type `Launchpad`, optionally type a description, select `USD — US Dollar`. Click `Create Program`.
9. Verify the dialog closes, a toast `"Program created"` fires, and the tab now shows one card `Launchpad` with a `USD` outline badge.
10. Click `New Program` again. Type `launchpad` (lowercase). Click `Create Program`.
11. Verify the dialog stays open and a destructive `Alert` shows `A program named "launchpad" already exists.` (exact string per Phase 1 §1B).
12. Cancel the dialog. Click `New Program`. Type `Accelerator` with no description. Click `Create Program`.
13. Verify two cards now exist in the list.
14. On the `Launchpad` row, click `⋮ → Edit`. Verify the dialog opens in edit mode with the title `"Edit Program"` and the form hydrated.
15. Change the currency to `EUR`. Click `Save Changes`. Verify the card re-renders with an `EUR` badge.
16. On the `Accelerator` row, click `⋮ → Archive`. Verify an `AlertDialog` opens with a destructive Archive confirmation. Click `Archive`.
17. Verify `toast.success('"Accelerator" archived')` fires and the row disappears from the list. The footer hint `1 program is archived. Toggle "Show archived" to view them.` appears.
18. Toggle `Show archived` on. Verify the `Accelerator` row re-appears with 70% opacity and an `Archived` secondary badge.
19. On the `Launchpad` row, click `⋮ → Archive`. Verify an `AlertDialog` opens; click `Archive`.
20. Verify `toast.error('At least one active program is required. ...')` fires (exact string per Phase 1 §1B). The `Launchpad` row stays active.
21. Dismiss the AlertDialog via Cancel.
22. On the `Accelerator` row (archived), click `⋮ → Restore`. Verify an `AlertDialog` opens; click `Restore`.
23. Verify `toast.success('"Accelerator" restored')` fires and the row returns to full opacity with no archived badge.
24. Sign out. Sign in as `closer@seed.dev`. Navigate to `/workspace/settings`.
25. Verify a redirect to `/workspace/closer` fires (the page-level `isAdmin` gate rejects closer role).
26. Back as `tenant_master`, navigate to an active meeting at `/workspace/closer/meetings/<id>` (requires Phase 7's payment-form-dialog to be built; if Phase 7 is not yet shipped, skip this step and verify later).
27. Open the Log Payment dialog. Verify the Program dropdown now lists `Launchpad` and `Accelerator` (alphabetical). Archive `Accelerator` in another tab, refresh the meeting tab, verify the dropdown now only shows `Launchpad`.

**Expected outcomes:** every assertion above passes. No console errors. No network errors. The toast + Alert messages match verbatim. The keyboard flow is usable (Tab → Focus on the "Programs" trigger → Enter → focus moves into the tab content → first focusable is the `Show archived` switch).

---

## Follow-up Notes (out-of-scope for Phase 6)

- **Bulk-import of programs** (CSV upload) is deferred until the bookkeeper role lands (Open Question #13 in the design doc). The `ensureInitialProgramForTenant` seed helper is sufficient for the v0.5.1 rollout.
- **Per-program aggregate** (`programRevenue` cached table) is explicitly rejected for MVP (Open Question #6). Phase 5 already handles per-program totals via in-memory reduce on the bounded `paymentRecords` scan. If a tenant grows past 2,500 payments per report window, revisit.
- **Program description markdown rendering**: the description is currently plain text (no markdown). If admins ask for links / formatting, upgrade to a `react-markdown` render with a strict allowlist. Do not introduce markdown in Phase 6.
- **Per-program payment-type restrictions** (e.g., "Launchpad only allows PIF") is deferred (Open Question #3). The MVP shape is name + description only.
- **Programs in the admin pipeline filter dropdown**: Phase 9's Reports UI will thread `programId` as a filter on every report surface. The Pipeline list page (`/workspace/pipeline`) does not filter by program in MVP because pipeline stages are pre-payment.
- **Cmd+K command palette entry**: adding "Create program" / "Go to Programs tab" as command-palette entries is a small nicety deferred to a post-v0.5.1 polish pass. See `components/command-palette.tsx`.
- **`ProgramSelect` search / combobox**: at 10+ programs a search filter would help. Radix's `<Select>` does not have built-in search. Upgrade to a shadcn `<Combobox>` when tenant feedback arrives. Not needed for v0.5.1's single-tenant pilot.

---

## Files Touched Summary

| File | Action | Subphase |
|---|---|---|
| `app/workspace/closer/_components/program-select.tsx` | Create | 6A |
| `app/workspace/settings/_components/program-form-dialog.tsx` | Create | 6B |
| `app/workspace/settings/_components/program-row.tsx` | Create | 6C |
| `app/workspace/settings/_components/programs-tab.tsx` | Create | 6D |
| `app/workspace/settings/_components/settings-page-client.tsx` | Modify | 6E |

**Total:** 4 new frontend files, 1 modified — all under 500 lines individually, all following the canonical shadcn + RHF + Zod pattern from `AGENTS.md § Form Patterns`.
