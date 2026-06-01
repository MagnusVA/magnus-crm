# Phase 4 — Settings UI: Field Mappings Tab & Dialog

**Goal:** Add a "Field Mappings" tab to the Settings page that displays event types with auto-discovered field stats and provides a configuration dialog for mapping Calendly form questions to CRM identity fields. After this phase, an admin can navigate to Settings → Field Mappings, see all event types with their booking counts and discovered form fields, click "Configure" on any event type, and save social handle / phone mappings via dropdowns populated from real booking data.

**Prerequisite:** Phase 1 (schema) and Phase 3 (mutation + query) complete and deployed. Phase 2 (auto-discovery) should also be deployed so that `knownCustomFieldKeys` is populated from real bookings — but Phase 4 handles the empty state gracefully if Phase 2 hasn't run yet.

**Runs in PARALLEL with:** Nothing — Phase 4 depends on Phase 3 (needs `updateCustomFieldMappings` mutation and `getEventTypeConfigsWithStats` query). It is the final phase of Feature F.

> **Critical path:** This phase is the last step on the critical path (Phase 1 → Phase 3 → Phase 4). Completing it unblocks the Feature F quality gate and the overall Window 1 gate, which in turn unblocks Feature E (Lead Identity Resolution) in Window 2.

**Skills to invoke:**
- `shadcn` — Building the Field Mappings tab and Field Mapping Dialog using shadcn/ui components (`Select`, `Card`, `Badge`, `Alert`, `Dialog`, `Form`).
- `frontend-design` — Production-grade tab layout, card list design, dialog form UX. Ensure the tab feels consistent with the existing "Calendly" and "Event Types" tabs.
- `expect` — Browser QA after all subphases complete: verify rendering, form validation, responsive layout across 4 viewports, accessibility audit, console error check, performance metrics.
- `vercel-react-best-practices` — React patterns: `useEffect` for form reset on dialog open, `form.watch()` for conditional field disabling, dynamic imports for the dialog.

**Acceptance Criteria:**
1. Settings page has a third tab labeled "Field Mappings" after "Event Types".
2. Field Mappings tab shows a card list of event types, each displaying: display name, last booking date (relative, e.g., "2 days ago"), booking count, and form field count.
3. Each event type card has a "Configure" button. The button is disabled when `fieldCount === 0`.
4. Clicking "Configure" opens a dialog with three `<Select>` dropdowns: Social Handle Field, Social Platform, and Phone Field (Override).
5. Social Handle Field and Phone Field dropdowns are populated from `knownCustomFieldKeys`. Each includes a "(none)" option.
6. Social Platform dropdown is disabled when Social Handle Field is "(none)".
7. If Social Handle Field is selected but Social Platform is not, form validation shows an inline error: "Select a platform when a social handle field is mapped."
8. Saving calls `updateCustomFieldMappings` mutation; success shows "Field mappings saved" toast and closes the dialog.
9. Mutation errors display in a destructive `Alert` inside the dialog (dialog stays open for retry).
10. Existing configured mappings are pre-populated in the dialog when editing.
11. Empty state (no event types) shows: "Event types appear here after their first booking."
12. An info alert at the top of the tab explains: "Configure how your CRM identifies leads from booking form data."
13. `posthog.capture("field_mapping_saved", ...)` fires on successful save with `event_type_config_id`, `has_social_handle`, `social_platform`, and `has_phone_override` properties.
14. All components use shadcn/ui primitives (no custom components outside `components/ui/`).
15. Responsive: cards stack vertically on mobile, dialog is scrollable on small viewports.
16. Accessibility: all form fields have associated labels, `aria-label` on action buttons, keyboard navigation works through the dialog.
17. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
4A (Field Mappings Tab component) ──────────────────────────────────┐
                                                                    │
4B (Field Mapping Dialog component) ────────────────────────────────┤
                                                                    ├── 4C (Wire into Settings page)
                                                                    │
                                                                    └── 4D (Browser verification — Expect)
```

**Optimal execution:**
1. Start 4A and 4B in parallel (they create separate new files with no dependencies on each other).
2. Once 4A and 4B are done → start 4C (modify `settings-page-client.tsx` to import and render both components).
3. Once 4C is done → start 4D (browser QA with Expect).

**Estimated time:** 2-3 hours

---

## Subphases

### 4A — Create Field Mappings Tab Component

**Type:** Frontend
**Parallelizable:** Yes — independent of 4B. Creates a new file `field-mappings-tab.tsx` that 4B does not touch. Both 4A and 4B are new files with no overlap.

**What:** Create the `FieldMappingsTab` component that renders the card list of event types with stats, a "Configure" button per card, and the empty state. This component consumes the output of `getEventTypeConfigsWithStats` (Phase 3B) and manages the selected-config + dialog-open state.

**Why:** The tab is the primary UI surface for Feature F. It provides the admin's entry point to field mapping configuration. Without it, the admin has no way to see which event types have been discovered or access the mapping dialog.

**Where:**
- `app/workspace/settings/_components/field-mappings-tab.tsx` (new)

**How:**

**Step 1: Create the component file**

```tsx
// Path: app/workspace/settings/_components/field-mappings-tab.tsx
"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { InfoIcon, Settings2Icon, CalendarIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { formatDistanceToNow } from "date-fns";

// Lazy-load dialog — only rendered on user interaction
const FieldMappingDialog = dynamic(() =>
  import("./field-mapping-dialog").then((m) => ({
    default: m.FieldMappingDialog,
  })),
);

interface CustomFieldMappings {
  socialHandleField?: string;
  socialHandleType?: "instagram" | "tiktok" | "twitter" | "other_social";
  phoneField?: string;
}

interface EventTypeConfigWithStats {
  _id: string;
  calendlyEventTypeUri: string;
  displayName: string;
  customFieldMappings?: CustomFieldMappings;
  knownCustomFieldKeys?: string[];
  bookingCount: number;
  lastBookingAt?: number;
  fieldCount: number;
}

interface FieldMappingsTabProps {
  configs: EventTypeConfigWithStats[];
}

const SOCIAL_PLATFORM_LABELS: Record<string, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  twitter: "X (Twitter)",
  other_social: "Other",
};

export function FieldMappingsTab({ configs }: FieldMappingsTabProps) {
  const [selectedConfig, setSelectedConfig] =
    useState<EventTypeConfigWithStats | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const handleConfigure = (config: EventTypeConfigWithStats) => {
    setSelectedConfig(config);
    setDialogOpen(true);
  };

  const handleSuccess = () => {
    setDialogOpen(false);
    setSelectedConfig(null);
  };

  if (configs.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CalendarIcon />
          </EmptyMedia>
          <EmptyTitle>No event types yet</EmptyTitle>
          <EmptyDescription>
            Event types appear here after their first booking. Connect Calendly
            and wait for incoming bookings to auto-discover form fields.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Alert>
        <InfoIcon className="size-4" />
        <AlertDescription>
          Configure how your CRM identifies leads from booking form data.
          Event types and their form questions are managed in Calendly —
          field names below are auto-discovered from actual bookings.
        </AlertDescription>
      </Alert>

      <div className="flex flex-col gap-3">
        {configs.map((config) => {
          const hasMappings = !!(
            config.customFieldMappings?.socialHandleField ||
            config.customFieldMappings?.phoneField
          );

          return (
            <Card key={config._id}>
              <CardContent className="flex items-center justify-between py-4">
                <div className="flex flex-col gap-1">
                  <p className="font-medium">{config.displayName}</p>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                    {config.lastBookingAt && (
                      <span>
                        Last booking:{" "}
                        {formatDistanceToNow(config.lastBookingAt, {
                          addSuffix: true,
                        })}
                      </span>
                    )}
                    <span>
                      {config.bookingCount}{" "}
                      {config.bookingCount === 1 ? "booking" : "bookings"}
                    </span>
                    <span>
                      {config.fieldCount}{" "}
                      {config.fieldCount === 1 ? "form field" : "form fields"}
                    </span>
                  </div>
                  {hasMappings && (
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {config.customFieldMappings?.socialHandleField && (
                        <Badge variant="secondary">
                          {SOCIAL_PLATFORM_LABELS[
                            config.customFieldMappings.socialHandleType ??
                              "other_social"
                          ] ?? "Social"}{" "}
                          mapped
                        </Badge>
                      )}
                      {config.customFieldMappings?.phoneField && (
                        <Badge variant="secondary">Phone mapped</Badge>
                      )}
                    </div>
                  )}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleConfigure(config)}
                  disabled={config.fieldCount === 0}
                  aria-label={`Configure field mappings for ${config.displayName}`}
                >
                  <Settings2Icon className="mr-2 size-4" />
                  Configure
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {selectedConfig && (
        <FieldMappingDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          config={selectedConfig}
          onSuccess={handleSuccess}
        />
      )}
    </div>
  );
}
```

**Key implementation notes:**
- **Dynamic import for the dialog:** `FieldMappingDialog` is lazy-loaded via `next/dynamic`. It's only needed when the admin clicks "Configure", so it stays out of the initial bundle. This matches the established pattern in `event-type-config-list.tsx` (line 18-22).
- **Disabled button when `fieldCount === 0`:** If no bookings have arrived for this event type yet, there are no discovered keys → the dropdown would be empty → nothing to configure. The button is disabled to prevent a confusing empty-dropdown experience.
- **`formatDistanceToNow`:** From `date-fns` (already installed and listed in `next.config.ts` `optimizePackageImports`). Produces human-readable strings like "2 days ago".
- **Mapping badges:** When an admin has configured mappings, badges like "Instagram mapped" and "Phone mapped" appear below the stats line. This gives at-a-glance visibility of configured vs. unconfigured event types.
- **Responsive layout:** The card list uses `flex-col` for vertical stacking. Stats wrap via `flex-wrap`. On mobile, the "Configure" button stays right-aligned via `justify-between`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/settings/_components/field-mappings-tab.tsx` | Create | Field Mappings tab content component |

---

### 4B — Create Field Mapping Dialog Component

**Type:** Frontend
**Parallelizable:** Yes — independent of 4A. Creates a new file `field-mapping-dialog.tsx` that 4A does not touch.

**What:** Create the `FieldMappingDialog` component — a form dialog with three `<Select>` dropdowns (Social Handle Field, Social Platform, Phone Override) using the RHF + Zod form pattern established in Feature J. The dialog validates inputs, calls `updateCustomFieldMappings`, and handles success/error states.

**Why:** The dialog is the admin's primary interaction point for configuring field mappings. It translates the `knownCustomFieldKeys` array into selectable dropdown options and calls the backend mutation to persist the admin's choices.

**Where:**
- `app/workspace/settings/_components/field-mapping-dialog.tsx` (new)

**How:**

**Step 1: Create the component file**

The dialog follows the RHF + Zod pattern from Feature J. Key patterns to apply (per `AGENTS.md` Form Patterns section):
- `standardSchemaResolver` (not `zodResolver`) with Zod v4
- `import { z } from "zod"` (not `"zod/v3"`)
- Schema co-located in the dialog file
- `useEffect` to reset form when `open` prop changes (externally controlled dialog pattern — same as `role-edit-dialog.tsx`)
- `form.watch("fieldName")` for conditional rendering (disable platform dropdown when no social handle field selected)

```tsx
// Path: app/workspace/settings/_components/field-mapping-dialog.tsx
"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
  FormDescription,
} from "@/components/ui/form";
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

// Sentinel value for "no selection" in Select components
// (Radix Select doesn't support empty string as a value)
const NONE_VALUE = "__none__";

// Co-located Zod schema — per Feature J form pattern
const fieldMappingSchema = z
  .object({
    socialHandleField: z.string(),
    socialHandleType: z.string(),
    phoneField: z.string(),
  })
  .superRefine((data, ctx) => {
    // If social handle field is selected, require a platform type
    if (
      data.socialHandleField &&
      data.socialHandleField !== NONE_VALUE &&
      (!data.socialHandleType || data.socialHandleType === NONE_VALUE)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Select a platform when a social handle field is mapped.",
        path: ["socialHandleType"],
      });
    }
    // Prevent double-mapping the same question
    if (
      data.socialHandleField &&
      data.socialHandleField !== NONE_VALUE &&
      data.phoneField &&
      data.phoneField !== NONE_VALUE &&
      data.socialHandleField === data.phoneField
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Cannot use the same field for both social handle and phone.",
        path: ["phoneField"],
      });
    }
  });

type FieldMappingFormValues = z.infer<typeof fieldMappingSchema>;

interface CustomFieldMappings {
  socialHandleField?: string;
  socialHandleType?: "instagram" | "tiktok" | "twitter" | "other_social";
  phoneField?: string;
}

interface EventTypeConfigWithStats {
  _id: string;
  displayName: string;
  customFieldMappings?: CustomFieldMappings;
  knownCustomFieldKeys?: string[];
  fieldCount: number;
}

interface FieldMappingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: EventTypeConfigWithStats;
  onSuccess?: () => void;
}

const SOCIAL_PLATFORMS = [
  { value: "instagram", label: "Instagram" },
  { value: "tiktok", label: "TikTok" },
  { value: "twitter", label: "X (Twitter)" },
  { value: "other_social", label: "Other" },
] as const;

export function FieldMappingDialog({
  open,
  onOpenChange,
  config,
  onSuccess,
}: FieldMappingDialogProps) {
  const [submitError, setSubmitError] = useState<string | null>(null);

  const updateMappings = useMutation(
    api.eventTypeConfigs.mutations.updateCustomFieldMappings,
  );

  // Do NOT pass explicit generic — let the resolver infer types (per AGENTS.md)
  const form = useForm({
    resolver: standardSchemaResolver(fieldMappingSchema),
    defaultValues: {
      socialHandleField:
        config.customFieldMappings?.socialHandleField ?? NONE_VALUE,
      socialHandleType:
        config.customFieldMappings?.socialHandleType ?? NONE_VALUE,
      phoneField: config.customFieldMappings?.phoneField ?? NONE_VALUE,
    },
  });

  // Reset form when dialog opens with different config
  // (externally controlled dialog pattern — same as role-edit-dialog.tsx)
  useEffect(() => {
    if (open) {
      form.reset({
        socialHandleField:
          config.customFieldMappings?.socialHandleField ?? NONE_VALUE,
        socialHandleType:
          config.customFieldMappings?.socialHandleType ?? NONE_VALUE,
        phoneField: config.customFieldMappings?.phoneField ?? NONE_VALUE,
      });
      setSubmitError(null);
    }
  }, [open, config, form]);

  const knownKeys = config.knownCustomFieldKeys ?? [];

  const onSubmit = async (values: FieldMappingFormValues) => {
    setSubmitError(null);

    // Convert NONE_VALUE sentinel back to undefined for the mutation
    const mappings = {
      socialHandleField:
        values.socialHandleField !== NONE_VALUE
          ? values.socialHandleField
          : undefined,
      socialHandleType:
        values.socialHandleType !== NONE_VALUE
          ? (values.socialHandleType as
              | "instagram"
              | "tiktok"
              | "twitter"
              | "other_social")
          : undefined,
      phoneField:
        values.phoneField !== NONE_VALUE ? values.phoneField : undefined,
    };

    try {
      await updateMappings({
        eventTypeConfigId: config._id as Id<"eventTypeConfigs">,
        customFieldMappings: mappings,
      });

      posthog.capture("field_mapping_saved", {
        event_type_config_id: config._id,
        has_social_handle: !!mappings.socialHandleField,
        social_platform: mappings.socialHandleType ?? null,
        has_phone_override: !!mappings.phoneField,
      });

      toast.success("Field mappings saved");
      onOpenChange(false);
      onSuccess?.();
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to save field mappings";
      setSubmitError(message);
      posthog.captureException(error);
    }
  };

  const isSubmitting = form.formState.isSubmitting;
  const watchSocialField = form.watch("socialHandleField");
  const isSocialFieldSelected =
    watchSocialField && watchSocialField !== NONE_VALUE;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Configure Field Mappings</DialogTitle>
          <DialogDescription>
            Map Calendly form questions to CRM identity fields for{" "}
            <strong>{config.displayName}</strong>. Dropdowns show actual form
            field names discovered from bookings.
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
              name="socialHandleField"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Social Handle Field</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    value={field.value}
                    disabled={isSubmitting}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a form field..." />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={NONE_VALUE}>(none)</SelectItem>
                      {knownKeys.map((key) => (
                        <SelectItem key={key} value={key}>
                          {key}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    Which form question asks for the lead&apos;s social media
                    handle?
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="socialHandleType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Social Platform</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    value={field.value}
                    disabled={isSubmitting || !isSocialFieldSelected}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select platform..." />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={NONE_VALUE}>(none)</SelectItem>
                      {SOCIAL_PLATFORMS.map((p) => (
                        <SelectItem key={p.value} value={p.value}>
                          {p.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    Which social media platform does this handle belong to?
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="phoneField"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Phone Field (Override)</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    value={field.value}
                    disabled={isSubmitting}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a form field..." />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={NONE_VALUE}>(none)</SelectItem>
                      {knownKeys.map((key) => (
                        <SelectItem key={key} value={key}>
                          {key}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    Override if the lead&apos;s phone number is captured in a
                    custom form field instead of Calendly&apos;s built-in phone
                    field.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting && <Spinner className="mr-2 size-4" />}
                {isSubmitting ? "Saving..." : "Save Mappings"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
```

**Key implementation notes:**
- **`NONE_VALUE` sentinel:** Radix `<Select>` doesn't support empty string as a value. We use `"__none__"` as a sentinel that maps to `undefined` before calling the mutation. This is the same approach used in other select-based forms in the codebase.
- **`standardSchemaResolver` (not `zodResolver`):** Per `AGENTS.md` Form Patterns: Zod v4 implements Standard Schema. `zodResolver` from `@hookform/resolvers/zod` has type overloads that only match `zod/v3` compat — not the main `"zod"` export.
- **`.superRefine()` for cross-field validation:** Two cross-field rules: (1) platform required when social field selected, (2) no double-mapping. Errors are targeted to specific fields via `path: ["socialHandleType"]` and `path: ["phoneField"]`.
- **`form.watch("socialHandleField")`:** Subscribes to the social field value. When it's NONE_VALUE, the platform dropdown is disabled. This uses the `watch` pattern established in `invite-user-dialog.tsx`.
- **`useEffect` reset on `open` change:** Same pattern as `role-edit-dialog.tsx`. When the dialog opens (or the config changes), the form resets to the config's current mapping values.
- **Error handling:** Mutation errors show in a `<Alert variant="destructive">` inside the dialog. The dialog stays open so the admin can retry. Validation errors show inline via `<FormMessage />`.
- **PostHog analytics:** `field_mapping_saved` event fires on success with properties that track adoption (has_social_handle, social_platform, has_phone_override).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/settings/_components/field-mapping-dialog.tsx` | Create | Field mapping configuration dialog (RHF + Zod) |

---

### 4C — Wire Field Mappings Tab into Settings Page

**Type:** Frontend
**Parallelizable:** No — depends on 4A (tab component) and 4B (dialog component, imported dynamically by 4A). Must wait for both to exist.

**What:** Modify `settings-page-client.tsx` to add a third tab trigger ("Field Mappings"), subscribe to the `getEventTypeConfigsWithStats` query, and render the `FieldMappingsTab` component in the new tab content area.

**Why:** The existing Settings page only has "Calendly" and "Event Types" tabs. The `FieldMappingsTab` component (4A) exists but isn't rendered anywhere. This subphase wires it in.

**Where:**
- `app/workspace/settings/_components/settings-page-client.tsx` (modify)

**How:**

**Step 1: Add import for `FieldMappingsTab`**

```tsx
// Path: app/workspace/settings/_components/settings-page-client.tsx
// BEFORE (current imports, lines 10-12):
import SettingsLoading from "../loading";
import { CalendlyConnection } from "./calendly-connection";
import { EventTypeConfigList } from "./event-type-config-list";

// AFTER:
import SettingsLoading from "../loading";
import { CalendlyConnection } from "./calendly-connection";
import { EventTypeConfigList } from "./event-type-config-list";
import { FieldMappingsTab } from "./field-mappings-tab";
```

**Step 2: Add query subscription for `getEventTypeConfigsWithStats`**

```tsx
// Path: app/workspace/settings/_components/settings-page-client.tsx
// BEFORE (current queries, lines 19-26):
  const eventTypeConfigs = useQuery(
    api.eventTypeConfigs.queries.listEventTypeConfigs,
    isAdmin ? {} : "skip",
  );
  const connectionStatus = useQuery(
    api.calendly.oauthQueries.getConnectionStatus,
    isAdmin ? {} : "skip",
  );

// AFTER:
  const eventTypeConfigs = useQuery(
    api.eventTypeConfigs.queries.listEventTypeConfigs,
    isAdmin ? {} : "skip",
  );
  const connectionStatus = useQuery(
    api.calendly.oauthQueries.getConnectionStatus,
    isAdmin ? {} : "skip",
  );
  const configsWithStats = useQuery(
    api.eventTypeConfigs.queries.getEventTypeConfigsWithStats,
    isAdmin ? {} : "skip",
  );
```

**Step 3: Add `configsWithStats` to the loading gate**

```tsx
// Path: app/workspace/settings/_components/settings-page-client.tsx
// BEFORE (line 34):
  if (!isAdmin || eventTypeConfigs === undefined || connectionStatus === undefined) {

// AFTER:
  if (
    !isAdmin ||
    eventTypeConfigs === undefined ||
    connectionStatus === undefined ||
    configsWithStats === undefined
  ) {
```

**Step 4: Add the tab trigger and content**

```tsx
// Path: app/workspace/settings/_components/settings-page-client.tsx
// BEFORE (TabsList, lines 48-54):
        <TabsList>
          <TabsTrigger value="calendly">Calendly</TabsTrigger>
          <TabsTrigger value="event-types">Event Types</TabsTrigger>
          {/* Future tabs: */}
          {/* <TabsTrigger value="notifications">Notifications</TabsTrigger> */}
          {/* <TabsTrigger value="billing">Billing</TabsTrigger> */}
        </TabsList>

// AFTER:
        <TabsList>
          <TabsTrigger value="calendly">Calendly</TabsTrigger>
          <TabsTrigger value="event-types">Event Types</TabsTrigger>
          <TabsTrigger value="field-mappings">Field Mappings</TabsTrigger>
        </TabsList>

// BEFORE (only two TabsContent, lines 56-63):
        <TabsContent value="calendly" className="mt-6">
          <CalendlyConnection connectionStatus={connectionStatus} />
        </TabsContent>

        <TabsContent value="event-types" className="mt-6">
          <EventTypeConfigList configs={eventTypeConfigs} />
        </TabsContent>

// AFTER:
        <TabsContent value="calendly" className="mt-6">
          <CalendlyConnection connectionStatus={connectionStatus} />
        </TabsContent>

        <TabsContent value="event-types" className="mt-6">
          <EventTypeConfigList configs={eventTypeConfigs} />
        </TabsContent>

        <TabsContent value="field-mappings" className="mt-6">
          <FieldMappingsTab configs={configsWithStats} />
        </TabsContent>
```

**Key implementation notes:**
- **Removed future tab comments:** The `{/* Future tabs: */}` comments for "Notifications" and "Billing" are removed. The "Field Mappings" tab replaces the placeholder position. If notifications/billing tabs are needed later, they can be added after "Field Mappings".
- **Loading gate includes `configsWithStats`:** The settings page shows a loading skeleton until all three queries resolve. This prevents the Field Mappings tab from rendering with `undefined` data.
- **`configsWithStats` uses `"skip"` when not admin:** Same pattern as the existing queries. Closers never see the Settings page (redirected by `useEffect`), so the query is skipped.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/settings/_components/settings-page-client.tsx` | Modify | Add import, query, loading gate, tab trigger + content |

---

### 4D — Browser Verification with Expect

**Type:** Manual / QA
**Parallelizable:** No — depends on 4C. Must run after all UI changes are deployed.

**What:** Use the Expect MCP tools to verify the Field Mappings tab and dialog work correctly in a real browser across multiple viewports, with accessibility and performance audits.

**Why:** Per `AGENTS.md` Testing with Expect section: "No completion claims without browser evidence." Feature F adds new UI to the Settings page — it must be verified visually, functionally, and for accessibility before the feature is considered complete.

**Where:**
- Browser (via Expect MCP tools)

**How:**

**Step 1: Open the Settings page**

Use `mcp__expect__open` to navigate to `/workspace/settings` as an admin user.

**Step 2: Navigate to Field Mappings tab**

Click the "Field Mappings" tab. Verify:
- Tab renders with event type cards (if bookings exist) or the empty state
- Each card shows display name, stats, and "Configure" button
- Cards with configured mappings show badges ("Instagram mapped", "Phone mapped")

**Step 3: Test the Configure dialog**

Click "Configure" on an event type with discovered fields. Verify:
- Dialog opens with the correct event type name
- Social Handle Field dropdown is populated with question texts from `knownCustomFieldKeys`
- Social Platform dropdown is disabled when Social Handle Field is "(none)"
- Phone Field dropdown is populated with the same question texts
- Select a social handle field → select a platform → save → toast confirmation

**Step 4: Test form validation**

- Select a social handle field but leave platform as "(none)" → submit → inline error on platform field
- Select the same question for both social handle and phone → submit → inline error on phone field
- Clear all fields → save → should succeed (clearing mappings)

**Step 5: Test error recovery**

(Optional — hard to simulate): Disconnect network → attempt save → error alert in dialog → reconnect → retry → success.

**Step 6: Responsive testing (4 viewports)**

Use `mcp__expect__screenshot` at:
1. Desktop (1440px)
2. Laptop (1024px)
3. Tablet (768px)
4. Mobile (375px)

Verify: cards stack correctly, dialog is scrollable, buttons remain accessible.

**Step 7: Accessibility audit**

Use `mcp__expect__accessibility_audit` to run axe-core + IBM Equal Access. Verify:
- No critical or serious violations
- All form fields have associated labels
- Dialog is keyboard-navigable (Tab through fields, Enter to submit, Escape to close)
- Action buttons have aria-labels

**Step 8: Performance metrics**

Use `mcp__expect__performance_metrics` to capture Web Vitals. Verify:
- LCP < 2.5s
- CLS < 0.1
- No long animation frames

**Step 9: Console error check**

Use `mcp__expect__console_logs` to verify no errors or warnings in the browser console.

**Key implementation notes:**
- **Data prerequisite:** The Field Mappings tab needs real data — at least 2-3 event type configs with bookings that had custom questions. If no test data exists, trigger test bookings via Calendly before running the Expect verification.
- **Delegate to a subagent:** Per `AGENTS.md` Expect rules, delegate browser verification to a subagent so the main thread stays free for other work.
- **Completion gate:** Feature F is NOT considered complete until 4D passes. The accessibility audit, performance metrics, and console error check are mandatory.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| (none) | — | This subphase is browser verification only |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `app/workspace/settings/_components/field-mappings-tab.tsx` | Create | 4A |
| `app/workspace/settings/_components/field-mapping-dialog.tsx` | Create | 4B |
| `app/workspace/settings/_components/settings-page-client.tsx` | Modify | 4C |
