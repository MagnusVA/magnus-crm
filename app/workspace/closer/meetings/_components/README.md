# Meeting Detail Page Components

This directory contains all UI components for the meeting detail page (`/workspace/closer/meetings/[meetingId]`).

## Component Hierarchy

The closer's page and the admin twin (`/workspace/pipeline/meetings/[meetingId]`)
render the same `MeetingDetailView`; `mode` picks the closer or admin mutations.

```
MeetingDetailView (meeting-detail-view.tsx)
├── CallStrip — the call as one board row: time, person, program, gate, status
├── PotentialDuplicateBanner, reassignment alert, RescheduleChainBanner
├── left column
│   ├── OutcomeSection — the page's one next action, one of:
│   │   ├── outcome question: "Did Ana show up?", then won, follow-up or lost
│   │   ├── UnfinishedFollowUpBanner, while a follow-up is pending (PR #214)
│   │   ├── NoShowActionBar, on a deal a no-show closed
│   │   ├── RescheduleLinkDisplay, right after a reschedule link is generated
│   │   ├── a note that the question opens 5 minutes before the call
│   │   └── a one-line summary once the outcome is recorded
│   │   (hosts PaymentFormDialog, FollowUpDialog, MarkLostDialog,
│   │    MarkNoShowDialog, or the admin dialogs in admin mode)
│   ├── PrepCard — booking answers and DM portal notes (leads before the call)
│   ├── PaymentLinksPanel
│   └── MeetingComments
└── right column
    ├── DealCard — stage track, credit line, first touch, Open deal
    ├── PersonCard — copyable contacts, other meetings, person page
    └── FathomLinkField
```

"Showed up" writes nothing: no mutation marks a call held without its result,
so it only opens step 2. Logging a payment, a follow-up, or a loss each marks
the call held as it writes the deal. A no-show closes the deal as lost
(`closer/noShowActions.markNoShow`); a reschedule link reopens it at Follow-up.

The dialogs take `open` and `onOpenChange`; when `open` is set they render no
trigger button, so the outcome panel owns the buttons.

## Phase 7 Components (Payment & Follow-Up)

### PaymentFormDialog (7D)

**Purpose:** Log a payment for an in-progress meeting.

**Props:**
```typescript
{
  opportunityId: Id<"opportunities">;
  meetingId: Id<"meetings">;
}
```

**Form Fields:**
- **Amount** (required): Decimal number, must be > 0
- **Currency** (required): USD, EUR, GBP, CAD, AUD, JPY (defaults to USD)
- **Provider** (required): Stripe, PayPal, Square, Cash, Bank Transfer, Other
- **Reference Code** (optional): Transaction ID from payment provider
- **Proof File** (optional): Image (PNG, JPEG, GIF) or PDF, max 10MB

**Behavior:**
- Opens as modal dialog triggered by "Log Payment" button
- Two-step file upload:
  1. Calls `generateUploadUrl()` to get Convex storage URL
  2. Uploads file directly to that URL
  3. Passes returned `storageId` to `logPayment()`
- On success:
  - Opportunity transitions to `payment_received` (terminal)
  - Dialog closes, form resets
  - Toast notification shown
- Errors:
  - File size/type validation (client)
  - Amount validation
  - Provider selection required
  - Displayed in `<Alert variant="destructive">`

**Accessibility:**
- All form fields have `<Label>` with `htmlFor` association
- Required fields marked with `*`
- File input has `aria-describedby` linking to help text
- Error messages semantic and accessible

**Loading States:**
- Submit button shows "Logging..." + spinner during submission
- All fields disabled during submission (prevent double-submit)

---

### FollowUpDialog (7E)

**Purpose:** Generate a single-use Calendly scheduling link for follow-ups.

**Props:**
```typescript
{
  opportunityId: Id<"opportunities">;
}
```

**Dialog States:**
1. **Idle** (initial):
   - "Generate Scheduling Link" button
   - Explanatory text
2. **Loading**:
   - Spinner
   - "Creating scheduling link..." message
3. **Success**:
   - Read-only input with booking URL
   - "Copy" button (shows "Copied!" for 2 seconds)
   - "Done" button
4. **Error**:
   - Error message in `<Alert>`
   - "Try Again" button
   - "Cancel" button

**Behavior:**
- Triggers `createFollowUp` action (calls Calendly API)
- Returns single-use booking link (`max_event_count: 1`)
- Closer can copy link and share with lead
- On success:
  - Opportunity transitions to `follow_up_scheduled`
  - Link ready to share
- On error:
  - Clear actionable error messages
  - Possible errors:
    - "Calendly is not connected"
    - "Missing Calendly scope: scheduling_links:write"
    - Network errors

**Copy Feedback:**
- Uses `navigator.clipboard.writeText()`
- Button shows "Copied!" for 2 seconds
- Toast notification: "Scheduling link copied to clipboard"

**State Reset:**
- On dialog close, all state resets (URL, error, copied status)
- Next open = clean state

**Accessibility:**
- Input has `aria-label="Scheduling link"`
- Copy button has dynamic `aria-label` ("Copy" → "Link copied")
- Semantic HTML structure

---

## Backend Mutations & Queries

### Phase 7A — Payment Mutations

```typescript
// Generate upload URL
await api.closer.payments.generateUploadUrl()
→ string (Convex storage URL)

// Log payment
await api.closer.payments.logPayment({
  opportunityId,
  meetingId,
  amount: 299.99,
  currency: "USD",
  provider: "Stripe",
  referenceCode: "pi_...",
  proofFileId: storageId  // optional
})
→ Id<"paymentRecords">

// Get payment proof URL
await api.closer.payments.getPaymentProofUrl({
  paymentRecordId
})
→ string | null
```

### Phase 7B — Follow-Up Action

```typescript
// Create follow-up scheduling link
await api.closer.followUp.createFollowUp({
  opportunityId,
  eventTypeUri: optional  // override event type
})
→ { bookingUrl: string }
```

---

## Usage Examples

### Standalone

```tsx
import { PaymentFormDialog } from './payment-form-dialog';
import { FollowUpDialog } from './follow-up-dialog';

export function MyComponent() {
  const opportunityId = 'abc123...';
  const meetingId = 'xyz789...';

  return (
    <div>
      <PaymentFormDialog
        opportunityId={opportunityId}
        meetingId={meetingId}
      />
      <FollowUpDialog opportunityId={opportunityId} />
    </div>
  );
}
```

---

## Testing Checklist

### PaymentFormDialog

- [ ] Dialog opens when clicking "Log Payment"
- [ ] All form fields render correctly
- [ ] Submit validates required fields (amount, provider)
- [ ] File upload accepts valid formats (PNG, JPEG, GIF, PDF)
- [ ] File upload rejects invalid formats
- [ ] File upload rejects files > 10MB
- [ ] On submit: payment recorded, opportunity status updated to `payment_received`
- [ ] On success: dialog closes, form resets
- [ ] Error messages display correctly
- [ ] Loading state prevents double-submission

### FollowUpDialog

- [ ] Dialog opens when clicking "Schedule Follow-up"
- [ ] Generate button triggers API call
- [ ] Loading state shows spinner
- [ ] On success: link displays in read-only input
- [ ] Copy button works and shows "Copied!" feedback
- [ ] Done button closes dialog
- [ ] On error: error message shows, retry button appears
- [ ] Dialog state fully resets on close

---

## Performance Notes

- **PaymentFormDialog:**
  - File upload is 2-step (get URL, then POST directly)
  - Avoids server-side body handling for large files
  - Form validation is mostly client-side

- **FollowUpDialog:**
  - Single API call to Calendly (O(1) time)
  - No polling or retries (fail-fast on network error)
  - Dialog state is lightweight (only `bookingUrl`, `state`, `error`)

---

## Accessibility

Both components follow WCAG Level AA standards:

✅ Semantic HTML (no div-based buttons)
✅ Form labels with `htmlFor` associations
✅ ARIA labels on inputs/buttons
✅ Keyboard navigation (Tab, Enter, Escape)
✅ Focus management on dialog open/close
✅ Error messages in accessible alerts
✅ Color contrast meets WCAG standards
✅ Touch targets ≥ 44px
