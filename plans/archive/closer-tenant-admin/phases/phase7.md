# Phase 7 — Payment Logging & Follow-Up Scheduling

**Goal:** Complete the Closer outcome flow by implementing payment logging (with file-upload proof) and follow-up scheduling (via Calendly single-use scheduling links). After this phase, Closers can log payments to transition opportunities to "won," schedule follow-ups that automatically link back to existing opportunities when the lead books, and the full meeting lifecycle is complete end-to-end.

**Prerequisite:** Phase 6 (Meeting detail page and outcome actions — provides the UI context for payment and follow-up buttons) and Phase 3 (Pipeline processor — handles follow-up detection when a lead books a follow-up meeting).

**Acceptance Criteria:**
1. Closer clicks "Log Payment" → a modal form appears with amount, currency, provider, reference code, and optional proof file upload.
2. Payment proof files are uploaded to Convex file storage and accessible only within the tenant.
3. Submitting a payment transitions the opportunity to `payment_received` (terminal state).
4. Payment records appear on the meeting detail page under the opportunity.
5. Closer clicks "Schedule Follow-up" → a Calendly single-use scheduling link is generated and displayed.
6. The opportunity transitions to `follow_up_scheduled` after a follow-up is created.
7. When the lead books via the scheduling link, the pipeline processor (Phase 3) detects the existing `follow_up_scheduled` opportunity and links the new meeting to it instead of creating a new opportunity.
8. Follow-up records are stored with status tracking (pending → booked → expired).
9. `getPaymentProofUrl` returns a valid URL only for users within the same tenant.

---

## Subphases

### 7A — Payment Logging Backend

**Type:** Backend
**Parallelizable:** Yes — independent of 7B, 7C. After Phase 1 complete.

**What:** Create mutations for payment logging: `generateUploadUrl` (Convex file storage URL for proof uploads), `logPayment` (creates payment record + transitions opportunity), and `getPaymentProofUrl` (tenant-scoped proof file access).

**Why:** Closers need to record successful payments during or after meetings. Payment proof (screenshots, receipts) must be uploaded and stored securely within Convex file storage. The `logPayment` mutation handles both the record creation and the opportunity status transition atomically.

**Where:** `convex/closer/payments.ts` (new file)

**How:**

```typescript
// convex/closer/payments.ts
import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { validateTransition } from "../lib/statusTransitions";

/**
 * Generate a file upload URL for payment proof.
 *
 * Returns a short-lived URL that the client uses to upload a file
 * to Convex file storage. The resulting storage ID is then passed
 * to logPayment as proofFileId.
 *
 * Accessible by closers and admins.
 */
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireTenantUser(ctx, ["closer", "tenant_master", "tenant_admin"]);
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Log a payment for an opportunity.
 *
 * Creates a paymentRecords entry and transitions the opportunity
 * to "payment_received" (terminal state).
 *
 * The payment proof file (if any) must already be uploaded to Convex
 * file storage via generateUploadUrl — pass the resulting storage ID
 * as proofFileId.
 *
 * Only closers can log payments on their own opportunities.
 * Admins can log payments on any opportunity.
 */
export const logPayment = mutation({
  args: {
    opportunityId: v.id("opportunities"),
    meetingId: v.id("meetings"),
    amount: v.number(),
    currency: v.string(),
    provider: v.string(),
    referenceCode: v.optional(v.string()),
    proofFileId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    const { userId, tenantId, role } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);

    // Load and validate the opportunity
    const opportunity = await ctx.db.get(args.opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }

    // Closer authorization: only own opportunities
    if (role === "closer" && opportunity.assignedCloserId !== userId) {
      throw new Error("Not your opportunity");
    }

    // Validate the meeting belongs to this opportunity
    const meeting = await ctx.db.get(args.meetingId);
    if (!meeting || meeting.opportunityId !== args.opportunityId) {
      throw new Error("Meeting does not belong to this opportunity");
    }

    // Validate status transition
    if (!validateTransition(opportunity.status, "payment_received")) {
      throw new Error(
        `Cannot log payment for opportunity with status "${opportunity.status}". ` +
        `Only "in_progress" opportunities can receive payments.`
      );
    }

    // Validate amount
    if (args.amount <= 0) {
      throw new Error("Payment amount must be positive");
    }

    // Create payment record
    const paymentId = await ctx.db.insert("paymentRecords", {
      tenantId,
      opportunityId: args.opportunityId,
      meetingId: args.meetingId,
      closerId: userId,
      amount: args.amount,
      currency: args.currency,
      provider: args.provider,
      referenceCode: args.referenceCode ?? undefined,
      proofFileId: args.proofFileId ?? undefined,
      status: "recorded",
      recordedAt: Date.now(),
    });

    // Transition opportunity to payment_received (terminal state)
    await ctx.db.patch(args.opportunityId, {
      status: "payment_received",
      updatedAt: Date.now(),
    });

    return paymentId;
  },
});

/**
 * Get a tenant-scoped URL for a payment proof file.
 *
 * Validates that the caller belongs to the same tenant as the
 * payment record before generating the file URL.
 *
 * Returns null if the record doesn't exist, has no proof file,
 * or the caller isn't authorized.
 */
export const getPaymentProofUrl = query({
  args: { paymentRecordId: v.id("paymentRecords") },
  handler: async (ctx, { paymentRecordId }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);

    const record = await ctx.db.get(paymentRecordId);
    if (!record || record.tenantId !== tenantId || !record.proofFileId) {
      return null;
    }

    return await ctx.storage.getUrl(record.proofFileId);
  },
});
```

**Key implementation notes:**
- `generateUploadUrl` returns a short-lived upload URL. The client uploads the file directly to Convex storage, then passes the resulting `storageId` (as `proofFileId`) to `logPayment`. This two-step process avoids passing large file data through the mutation.
- `logPayment` validates the status transition using `validateTransition("in_progress", "payment_received")`. Only `in_progress` opportunities can receive payments.
- `getPaymentProofUrl` validates tenant ownership before generating the URL. Convex file URLs are unguessable but short-lived — this adds an authorization layer.
- Payment amounts are stored as numbers. For MVP, this is the raw decimal amount (e.g., `99.99`). A future enhancement could store amounts in cents for precision.
- `referenceCode` and `proofFileId` use `v.optional()` — they may be undefined for cash payments or cases where proof isn't available.

**Files touched:** `convex/closer/payments.ts` (create)

---

### 7B — Follow-Up Scheduling Action (Calendly API)

**Type:** Backend
**Parallelizable:** Yes — independent of 7A. After Phase 1 complete + Calendly tokens exist.

**What:** Create the `createFollowUp` action that generates a single-use Calendly scheduling link, creates a follow-up record, and transitions the opportunity to `follow_up_scheduled`.

**Why:** Follow-ups are a critical part of the sales process. When a meeting doesn't close immediately, the closer needs to schedule a follow-up call. Using Calendly's single-use scheduling links ensures the lead books through the same system, and the pipeline processor (Phase 3C) automatically links the new meeting to the existing opportunity.

**Where:** `convex/closer/followUp.ts` (new file)

**How:**

```typescript
// convex/closer/followUp.ts
"use node";

import { v } from "convex/values";
import { action } from "../_generated/server";
import { internal } from "../_generated/api";

/**
 * Create a follow-up scheduling link for an opportunity.
 *
 * Flow:
 * 1. Validate caller is a closer with access to this opportunity
 * 2. Get a valid Calendly access token for the tenant
 * 3. Create a single-use scheduling link via Calendly API
 * 4. Create a followUps record (status: pending)
 * 5. Transition the opportunity to follow_up_scheduled
 * 6. Return the booking URL for the closer to share with the lead
 *
 * Note: This requires the scheduling_links:write Calendly scope.
 * If the scope is not available, this action will fail with a
 * clear error message.
 */
export const createFollowUp = action({
  args: {
    opportunityId: v.id("opportunities"),
    eventTypeUri: v.optional(v.string()),
  },
  handler: async (ctx, { opportunityId, eventTypeUri }) => {
    // ==== Step 1: Validate caller ====
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const workosUserId = identity.subject ?? identity.tokenIdentifier;
    const caller = await ctx.runQuery(
      internal.users.queries.getCurrentUserInternal,
      { workosUserId }
    );
    if (!caller || caller.role !== "closer") {
      throw new Error("Only closers can create follow-ups");
    }

    // Load the opportunity
    const opportunity = await ctx.runQuery(
      internal.opportunities.queries.getById,
      { opportunityId }
    );
    if (!opportunity || opportunity.tenantId !== caller.tenantId) {
      throw new Error("Opportunity not found");
    }
    if (opportunity.assignedCloserId !== caller._id) {
      throw new Error("Not your opportunity");
    }

    // ==== Step 2: Get valid Calendly access token ====
    const tokenData = await ctx.runQuery(
      internal.tenants.getCalendlyTokens,
      { tenantId: caller.tenantId }
    );
    if (!tokenData?.calendlyAccessToken) {
      throw new Error(
        "Calendly is not connected. Please ask your admin to reconnect Calendly."
      );
    }

    // Use the token refresh action to get a fresh token if needed
    let accessToken = tokenData.calendlyAccessToken;
    if (
      tokenData.calendlyTokenExpiresAt &&
      tokenData.calendlyTokenExpiresAt < Date.now() + 60000
    ) {
      // Token expired or expiring soon — attempt refresh
      const refreshed = await ctx.runAction(
        internal.calendly.tokens.refreshTenantTokenCore,
        { tenantId: caller.tenantId }
      );
      if (refreshed?.accessToken) {
        accessToken = refreshed.accessToken;
      } else {
        throw new Error(
          "Calendly token expired and could not be refreshed. Contact your admin."
        );
      }
    }

    // Determine which event type to use for the scheduling link
    const targetEventType = eventTypeUri ?? opportunity.calendlyEventUri;
    if (!targetEventType) {
      throw new Error(
        "No event type available for follow-up. The original Calendly event URI is missing."
      );
    }

    // ==== Step 3: Create single-use scheduling link via Calendly API ====
    const response = await fetch("https://api.calendly.com/scheduling_links", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        max_event_count: 1,
        owner: targetEventType,
        owner_type: "EventType",
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      if (response.status === 403) {
        throw new Error(
          "Missing Calendly scope: scheduling_links:write. " +
          "Please ask your admin to reconnect Calendly with the required scopes."
        );
      }
      throw new Error(
        `Failed to create scheduling link: ${response.status} ${errorBody}`
      );
    }

    const data = await response.json();
    const bookingUrl = data.resource.booking_url;

    // ==== Step 4: Create follow-up record ====
    await ctx.runMutation(internal.closer.followUpMutations.createFollowUpRecord, {
      tenantId: caller.tenantId,
      opportunityId,
      leadId: opportunity.leadId,
      closerId: caller._id,
      schedulingLinkUrl: bookingUrl,
      reason: "closer_initiated",
    });

    // ==== Step 5: Transition opportunity status ====
    await ctx.runMutation(internal.closer.followUpMutations.transitionToFollowUp, {
      opportunityId,
    });

    return { bookingUrl };
  },
});
```

**Key implementation notes:**
- This file uses `"use node"` because it makes HTTP requests to the Calendly API. Only actions can be exported.
- **Calendly API scope requirement:** `scheduling_links:write` must be in the OAuth scopes. If it's missing, the API returns 403. The error message guides the admin to reconnect with correct scopes.
- `max_event_count: 1` creates a **single-use** link — once the lead books, the link expires. This prevents duplicate bookings.
- The `owner` field references a Calendly event type URI, not a user URI. We use the original event type from the opportunity, or allow the closer to specify a different one.
- Token refresh is handled inline — if the token is expired or expiring within 60 seconds, we attempt a refresh before making the API call.
- The follow-up record and opportunity transition are done via internal mutations to keep the DB writes transactional.

**Files touched:** `convex/closer/followUp.ts` (create)

---

### 7C — Follow-Up Record Mutations

**Type:** Backend
**Parallelizable:** Yes — independent of 7A, can start alongside 7B. After Phase 1 complete.

**What:** Create internal mutations for follow-up record management: `createFollowUpRecord` and `transitionToFollowUp`.

**Why:** The `createFollowUp` action (7B) needs to write to the database via mutations. These internal mutations handle the follow-up record creation and opportunity status transition separately from the API-calling action for clean separation of concerns.

**Where:** `convex/closer/followUpMutations.ts` (new file)

**How:**

```typescript
// convex/closer/followUpMutations.ts
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { validateTransition } from "../lib/statusTransitions";

/**
 * Create a follow-up record.
 * Called by the createFollowUp action after generating the scheduling link.
 */
export const createFollowUpRecord = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    opportunityId: v.id("opportunities"),
    leadId: v.id("leads"),
    closerId: v.id("users"),
    schedulingLinkUrl: v.string(),
    reason: v.union(
      v.literal("closer_initiated"),
      v.literal("cancellation_follow_up"),
      v.literal("no_show_follow_up"),
    ),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("followUps", {
      tenantId: args.tenantId,
      opportunityId: args.opportunityId,
      leadId: args.leadId,
      closerId: args.closerId,
      schedulingLinkUrl: args.schedulingLinkUrl,
      reason: args.reason,
      status: "pending",
      createdAt: Date.now(),
    });
  },
});

/**
 * Transition an opportunity to follow_up_scheduled.
 * Validates the transition is allowed from the current status.
 */
export const transitionToFollowUp = internalMutation({
  args: { opportunityId: v.id("opportunities") },
  handler: async (ctx, { opportunityId }) => {
    const opportunity = await ctx.db.get(opportunityId);
    if (!opportunity) throw new Error("Opportunity not found");

    if (!validateTransition(opportunity.status, "follow_up_scheduled")) {
      throw new Error(
        `Cannot schedule follow-up from status "${opportunity.status}". ` +
        `Only "in_progress", "canceled", and "no_show" opportunities support follow-ups.`
      );
    }

    await ctx.db.patch(opportunityId, {
      status: "follow_up_scheduled",
      updatedAt: Date.now(),
    });
  },
});

/**
 * Mark a follow-up as booked (called when pipeline detects the follow-up booking).
 * This could be wired into the invitee.created handler in Phase 3.
 */
export const markFollowUpBooked = internalMutation({
  args: {
    opportunityId: v.id("opportunities"),
    calendlyEventUri: v.string(),
  },
  handler: async (ctx, { opportunityId, calendlyEventUri }) => {
    // Find the pending follow-up for this opportunity
    const followUp = await ctx.db
      .query("followUps")
      .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunityId))
      .filter((q) => q.eq(q.field("status"), "pending"))
      .first();

    if (followUp) {
      await ctx.db.patch(followUp._id, {
        status: "booked",
        calendlyEventUri,
      });
    }
  },
});
```

**Key implementation notes:**
- All mutations are `internalMutation` — only callable from other Convex functions.
- `transitionToFollowUp` validates the state transition. Follow-ups are allowed from `in_progress`, `canceled`, and `no_show` statuses.
- `markFollowUpBooked` is called by the pipeline processor (Phase 3C) when it detects a follow-up booking. It links the Calendly event URI to the follow-up record and updates its status to `booked`.
- Follow-up statuses: `pending` (link shared, waiting) → `booked` (lead booked) → `expired` (future: link expiration detection).

**Files touched:** `convex/closer/followUpMutations.ts` (create)

---

### 7D — Payment Form Modal UI

**Type:** Frontend
**Parallelizable:** Depends on 7A (payment mutations). Can start with UI shell.

**What:** Build the payment logging form modal that collects payment details and handles file upload for payment proof.

**Why:** When a sale closes during a meeting, the closer needs to record the payment quickly without leaving the meeting detail page. The modal form with file upload provides a streamlined flow.

**Where:** `app/workspace/closer/meetings/_components/payment-form-dialog.tsx` (new component)

**How:**

**Payment form fields:**

| Field | Component | Required | Validation |
|---|---|---|---|
| Amount | `<Input type="number" step="0.01" />` | Yes | Must be > 0 |
| Currency | `<Select>` | Yes | Default: "USD", options: USD, EUR, GBP, etc. |
| Provider | `<Select>` | Yes | Options: Stripe, PayPal, Cash, Bank Transfer, Other |
| Reference Code | `<Input />` | No | Transaction ID from the payment provider |
| Proof File | `<Input type="file" />` | No | Image or PDF (max 10MB) |

**Form flow:**
```
┌─────────────────────────────────────────────┐
│  Log Payment                            [X] │
│                                             │
│  Amount *     ┌─────────────────────────┐  │
│               │ 299.99                  │  │
│               └─────────────────────────┘  │
│                                             │
│  Currency *   ┌─────────────────────────┐  │
│               │ USD ▼                   │  │
│               └─────────────────────────┘  │
│                                             │
│  Provider *   ┌─────────────────────────┐  │
│               │ Stripe ▼                │  │
│               └─────────────────────────┘  │
│                                             │
│  Reference    ┌─────────────────────────┐  │
│  Code         │ pi_3abc123...           │  │
│               └─────────────────────────┘  │
│                                             │
│  Proof File   ┌─────────────────────────┐  │
│               │ [Choose File]           │  │
│               └─────────────────────────┘  │
│               receipt.png (uploaded ✓)      │
│                                             │
│         [Cancel]          [Log Payment]     │
└─────────────────────────────────────────────┘
```

```typescript
// app/workspace/closer/meetings/_components/payment-form-dialog.tsx
"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from "@/components/ui/select";

export function PaymentFormDialog({
  opportunityId,
  meetingId,
}: {
  opportunityId: Id<"opportunities">;
  meetingId: Id<"meetings">;
}) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [provider, setProvider] = useState("");
  const [referenceCode, setReferenceCode] = useState("");
  const [proofFile, setProofFile] = useState<File | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generateUploadUrl = useMutation(api.closer.payments.generateUploadUrl);
  const logPayment = useMutation(api.closer.payments.logPayment);

  const handleSubmit = async () => {
    setIsSubmitting(true);
    setError(null);

    try {
      const parsedAmount = parseFloat(amount);
      if (isNaN(parsedAmount) || parsedAmount <= 0) {
        throw new Error("Please enter a valid amount");
      }
      if (!provider) {
        throw new Error("Please select a payment provider");
      }

      // Upload proof file if provided
      let proofFileId: Id<"_storage"> | undefined;
      if (proofFile) {
        const uploadUrl = await generateUploadUrl();
        const uploadResult = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": proofFile.type },
          body: proofFile,
        });
        if (!uploadResult.ok) {
          throw new Error("Failed to upload proof file");
        }
        const { storageId } = await uploadResult.json();
        proofFileId = storageId;
      }

      // Log the payment
      await logPayment({
        opportunityId,
        meetingId,
        amount: parsedAmount,
        currency,
        provider,
        referenceCode: referenceCode || undefined,
        proofFileId,
      });

      // Success — close dialog
      setOpen(false);
      resetForm();
    } catch (err: any) {
      setError(err.message ?? "Failed to log payment");
    } finally {
      setIsSubmitting(false);
    }
  };

  const resetForm = () => {
    setAmount("");
    setCurrency("USD");
    setProvider("");
    setReferenceCode("");
    setProofFile(null);
    setError(null);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="lg">
          💰 Log Payment
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Log Payment</DialogTitle>
        </DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); handleSubmit(); }} className="space-y-4">
          {/* Form fields as described above */}
          {/* Amount, Currency, Provider, Reference Code, Proof File */}

          {error && (
            <div className="text-sm text-destructive" role="alert">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Logging..." : "Log Payment"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

**Frontend design guidelines to follow:**
- Use shadcn `Dialog` for the modal — accessible, keyboard-navigable.
- Use shadcn `Input`, `Select`, `Label` for form fields.
- File upload uses the native `<input type="file" />` with an accept filter for images and PDFs.
- The two-step upload flow (get URL → upload file → get storageId → pass to mutation) follows Convex file storage best practices.
- Error messages use `role="alert"` for screen reader announcement.
- Form values are retained on error so the user doesn't have to re-enter data.
- Follow `web-design-guidelines`: labels are explicitly associated with inputs via `htmlFor`/`id` pairs.

**Files touched:** `app/workspace/closer/meetings/_components/payment-form-dialog.tsx` (create)

---

### 7E — Follow-Up Scheduling UI

**Type:** Frontend
**Parallelizable:** Depends on 7B (createFollowUp action). Can start with UI shell.

**What:** Build the follow-up scheduling dialog that triggers the Calendly scheduling link creation and displays the shareable link to the closer.

**Why:** After a meeting where the lead needs more time, the closer creates a follow-up. The dialog triggers the backend action, then shows the scheduling link so the closer can copy it and share with the lead via email or chat.

**Where:** `app/workspace/closer/meetings/_components/follow-up-dialog.tsx` (new component)

**How:**

**Follow-up dialog flow:**
```
Step 1: Closer clicks "Schedule Follow-up"
  ↓
Step 2: Dialog appears with optional event type selector
  ↓
Step 3: Closer clicks "Generate Link"
  ↓
Step 4: Backend creates single-use Calendly link
  ↓
Step 5: Dialog shows the link with a "Copy" button
  ↓
Step 6: Closer copies link, shares with lead manually
  ↓
Step 7: Dialog closes. Opportunity status → follow_up_scheduled
```

**Dialog states:**

| State | UI |
|---|---|
| Initial | Event type selector (optional) + "Generate Link" button |
| Loading | Spinner + "Creating scheduling link..." |
| Success | Scheduling link displayed + "Copy Link" button + "Done" button |
| Error | Error message + "Try Again" button |

```typescript
// app/workspace/closer/meetings/_components/follow-up-dialog.tsx
"use client";

import { useState } from "react";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function FollowUpDialog({
  opportunityId,
}: {
  opportunityId: Id<"opportunities">;
}) {
  const [open, setOpen] = useState(false);
  const [bookingUrl, setBookingUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const createFollowUp = useAction(api.closer.followUp.createFollowUp);

  const handleGenerate = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const result = await createFollowUp({ opportunityId });
      setBookingUrl(result.bookingUrl);
    } catch (err: any) {
      setError(err.message ?? "Failed to create scheduling link");
    } finally {
      setIsLoading(false);
    }
  };

  const handleCopy = async () => {
    if (bookingUrl) {
      await navigator.clipboard.writeText(bookingUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => {
      setOpen(v);
      if (!v) {
        // Reset on close
        setBookingUrl(null);
        setError(null);
        setCopied(false);
      }
    }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="lg">
          📅 Schedule Follow-up
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Schedule Follow-up</DialogTitle>
        </DialogHeader>

        {!bookingUrl && !error && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Generate a single-use Calendly scheduling link to share with the lead.
              When they book, it will automatically link to this opportunity.
            </p>
            <Button onClick={handleGenerate} disabled={isLoading} className="w-full">
              {isLoading ? "Creating link..." : "Generate Scheduling Link"}
            </Button>
          </div>
        )}

        {bookingUrl && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Share this link with the lead. It can only be used once.
            </p>
            <div className="flex gap-2">
              <Input value={bookingUrl} readOnly className="flex-1" />
              <Button onClick={handleCopy} variant="outline">
                {copied ? "Copied!" : "Copy"}
              </Button>
            </div>
            <Button onClick={() => setOpen(false)} className="w-full">
              Done
            </Button>
          </div>
        )}

        {error && (
          <div className="space-y-4">
            <div className="text-sm text-destructive" role="alert">
              {error}
            </div>
            <Button onClick={handleGenerate} variant="outline" className="w-full">
              Try Again
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
```

**Frontend design guidelines to follow:**
- Use shadcn `Dialog` for the modal.
- The scheduling link should be in a read-only `Input` for easy selection and copying.
- "Copy" button uses `navigator.clipboard.writeText()` — shows "Copied!" confirmation for 2 seconds.
- Loading state uses a spinner or pulse animation to indicate the Calendly API call is in progress.
- Error messages are specific and actionable (e.g., "Missing Calendly scope" guides the admin to fix the issue).
- Dialog resets state on close to avoid stale data on re-open.
- Follow `web-design-guidelines`: the scheduling link `Input` should be `aria-label="Scheduling link"`.

**Files touched:** `app/workspace/closer/meetings/_components/follow-up-dialog.tsx` (create)

---

### 7F — Wire Payment & Follow-Up into Outcome Action Bar

**Type:** Frontend
**Parallelizable:** Depends on 7D and 7E. Final integration step.

**What:** Replace the placeholder "Log Payment" and "Schedule Follow-up" buttons in the outcome action bar (Phase 6D) with the real `PaymentFormDialog` and `FollowUpDialog` components.

**Why:** Phase 6D created placeholder disabled buttons for these actions. Now that the components exist, we wire them in to complete the full outcome action flow.

**Where:** `app/workspace/closer/meetings/_components/outcome-action-bar.tsx` (modify)

**How:**

```typescript
// Replace the placeholder buttons in outcome-action-bar.tsx:

// Before (Phase 6D placeholder):
{isInProgress && (
  <Button variant="outline" size="lg" disabled>
    💰 Log Payment
    <span className="ml-1 text-xs">(Phase 7)</span>
  </Button>
)}

// After (Phase 7F wired):
{isInProgress && (
  <PaymentFormDialog
    opportunityId={opportunity._id}
    meetingId={meeting._id}
  />
)}

// Before (Phase 6D placeholder):
{isInProgress && (
  <Button variant="outline" size="lg" disabled>
    📅 Schedule Follow-up
    <span className="ml-1 text-xs">(Phase 7)</span>
  </Button>
)}

// After (Phase 7F wired):
{isInProgress && (
  <FollowUpDialog opportunityId={opportunity._id} />
)}
```

Also add follow-up support for canceled and no-show opportunities:

```typescript
// Add follow-up button for canceled/no-show opportunities
{(opportunity.status === "canceled" || opportunity.status === "no_show") && (
  <FollowUpDialog opportunityId={opportunity._id} />
)}
```

**Files touched:** `app/workspace/closer/meetings/_components/outcome-action-bar.tsx` (modify)

---

## Parallelization Summary

```
Phase 6 Complete
  │
  ├── 7A (payment logging backend) ────────────────┐
  ├── 7B (follow-up scheduling action) ────────────┤  All 3 backend subphases
  └── 7C (follow-up record mutations) ─────────────┤  run in PARALLEL
                                                    │
  After backend subphases complete:                 │
  ├── 7D (payment form modal UI) ──────────────────┤
  └── 7E (follow-up scheduling UI) ────────────────┤  Both run in PARALLEL
                                                    │
  After frontend subphases complete:                │
  └── 7F (wire into outcome action bar) ───────────┘  Final integration
```

**Optimal execution:**
1. Start 7A, 7B, 7C all in parallel (backend).
2. Once backend is done → start 7D and 7E in parallel (frontend).
3. Once 7D + 7E are done → 7F (quick integration step).

**Estimated time:** 2–3 days

---

## Files Modified/Created Summary

| File | Action | Subphase |
|---|---|---|
| `convex/closer/payments.ts` | Created (generateUploadUrl, logPayment, getPaymentProofUrl) | 7A |
| `convex/closer/followUp.ts` | Created (createFollowUp action) | 7B |
| `convex/closer/followUpMutations.ts` | Created (createFollowUpRecord, transitionToFollowUp, markFollowUpBooked) | 7C |
| `app/workspace/closer/meetings/_components/payment-form-dialog.tsx` | Created | 7D |
| `app/workspace/closer/meetings/_components/follow-up-dialog.tsx` | Created | 7E |
| `app/workspace/closer/meetings/_components/outcome-action-bar.tsx` | Modified (wire real components) | 7F |

---

## End-to-End Flow Validation

After Phase 7 is complete, the full meeting lifecycle works end-to-end:

```
1. Admin invites Closer → CRM user + WorkOS user created (Phase 2)
2. Lead books via Calendly → webhook arrives → pipeline creates Lead + Opp + Meeting (Phase 3)
3. Closer sees meeting on dashboard → clicks to view detail (Phases 5 + 6)
4. Closer starts meeting → opens Zoom → status: in_progress (Phase 6)
5a. Closer logs payment → status: payment_received (DONE) (Phase 7)
5b. Closer schedules follow-up → link shared → status: follow_up_scheduled (Phase 7)
5c. Closer marks as lost → status: lost (DONE) (Phase 6)
6. [If follow-up] Lead books follow-up → pipeline links to existing opp → status: scheduled (Phase 3)
7. Repeat from step 3
```

---

*End of Phase 7 — and the entire Closer, Tenant Admin & Owner Dashboard implementation plan.*
