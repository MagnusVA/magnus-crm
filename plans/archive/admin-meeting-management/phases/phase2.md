# Phase 2: Pipeline-to-Meeting Navigation

> Make the "View" button in the pipeline table link to the admin meeting detail page.

## Dependencies

- Phase 3 must exist (at least the route) for the link to resolve. Can stub the page first.

---

## Step 1: Update the opportunities table

**File**: `app/workspace/pipeline/_components/opportunities-table.tsx`

### 1a. Add `Link` import

```tsx
import Link from "next/link";
```

### 1b. Update the Opportunity interface

The interface already has `latestMeetingId` but typed as `Id<"opportunities">` indirectly. Ensure the enriched type includes:

```ts
interface Opportunity {
  // ... existing fields ...
  latestMeetingId?: string | null;  // Id<"meetings"> serialized
  nextMeetingId?: string | null;    // Id<"meetings"> serialized
}
```

These are already returned by `listOpportunitiesForAdmin` enrichment.

### 1c. Replace the View button with a Link

Currently:
```tsx
<Button variant="ghost" size="sm" aria-label={`View details for ${opp.leadName}`}>
  View
  <ExternalLinkIcon data-icon="inline-end" />
</Button>
```

Replace with:
```tsx
{(() => {
  const targetMeetingId = opp.nextMeetingId ?? opp.latestMeetingId;
  if (!targetMeetingId) {
    return (
      <Button variant="ghost" size="sm" disabled aria-label="No meeting available">
        View
        <ExternalLinkIcon data-icon="inline-end" />
      </Button>
    );
  }
  return (
    <Button variant="ghost" size="sm" asChild aria-label={`View meeting for ${opp.leadName}`}>
      <Link href={`/workspace/pipeline/meetings/${targetMeetingId}`}>
        View
        <ExternalLinkIcon data-icon="inline-end" />
      </Link>
    </Button>
  );
})()}
```

Alternatively, cleaner with a separate variable:
```tsx
const targetMeetingId = opp.nextMeetingId ?? opp.latestMeetingId;

// In the Actions cell:
<TableCell className="text-right">
  {targetMeetingId ? (
    <Button variant="ghost" size="sm" asChild aria-label={`View meeting for ${opp.leadName}`}>
      <Link href={`/workspace/pipeline/meetings/${targetMeetingId}`}>
        View
        <ExternalLinkIcon data-icon="inline-end" />
      </Link>
    </Button>
  ) : (
    <Button variant="ghost" size="sm" disabled aria-label="No meeting available">
      View
      <ExternalLinkIcon data-icon="inline-end" />
    </Button>
  )}
</TableCell>
```

### 1d. Consider making the entire row clickable

For better UX, the entire table row could be clickable (navigates to meeting detail). Add:

```tsx
<TableRow
  key={opp._id}
  className={targetMeetingId ? "cursor-pointer hover:bg-muted/50" : undefined}
  onClick={targetMeetingId ? () => router.push(`/workspace/pipeline/meetings/${targetMeetingId}`) : undefined}
>
```

This requires adding `useRouter` to the component. Keep the explicit "View" button as well for accessibility (keyboard navigation).

---

## Step 2: Verify

- [ ] "View" button renders as a link with correct href
- [ ] Clicking navigates to the admin meeting detail page
- [ ] Opportunities without meetings show a disabled "View" button
- [ ] Row hover effect works for clickable rows
- [ ] Keyboard navigation (Tab → Enter on View button) works
- [ ] Back navigation from meeting detail returns to pipeline with filters preserved
