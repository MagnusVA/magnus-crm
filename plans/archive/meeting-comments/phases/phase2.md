# Phase 2 — Frontend: Comment System UI

**Goal:** Replace the "Meeting Notes" card in both the closer and admin meeting detail pages with a new "Comments" card backed by the Phase 1 Convex API. After this phase, users can post, edit, delete (admin only), and view threaded comments with real-time updates, URL auto-linking, and author attribution. The legacy `MeetingNotes` component file still exists on disk but is no longer imported anywhere — Phase 3 deletes it.

**Prerequisite:** Phase 1 deployed (`api.closer.meetingComments.{addComment,editComment,deleteComment,getComments}` callable; `Id<"meetingComments">` type emitted into `convex/_generated/dataModel.ts`).

**Runs in PARALLEL with:** **Phase 4** (data migration) — Phase 4 only touches a new file in `convex/closer/` and never modifies frontend code. Phase 3 **cannot** start until Phase 2 ships, because Phase 3 deletes `MeetingNotes` / `MeetingOutcomeSelect`, and those components are still imported by the page clients until the 2E/2F swaps land.

**Skills to invoke:**
- `frontend-design` — production-grade comment entry layout, avatar, hover states (comment-entry.tsx, comment-input.tsx).
- `shadcn` — reuse existing primitives (`Card`, `Textarea`, `Button`, `Badge`, `DropdownMenu`, `Spinner`). All required components are already installed — no new shadcn additions needed.
- `web-design-guidelines` — accessibility review (keyboard shortcuts, ARIA labels, focus management on inline edit mode).
- `vercel-react-best-practices` — ensure list rendering uses stable keys, callbacks memoized where useful, no unnecessary re-renders.
- `expect` — browser verification at 4 viewports (mobile/tablet/desktop/wide), accessibility audit, console-error check.

> **Critical path:** On the critical path (Phase 1 → Phase 2 → Phase 3). Start 2A immediately; it has zero backend dependencies.

---

## Acceptance Criteria

1. Navigating to `/workspace/closer/meetings/[meetingId]` renders a "Comments" card (with a message-square icon and count badge) instead of the old "Meeting Notes" card.
2. Navigating to `/workspace/pipeline/meetings/[meetingId]` (admin view) renders the same "Comments" card.
3. The outcome dropdown is gone from both pages (visually; the backend mutation and component are still deleted in Phase 3 — in Phase 2 they are simply no longer rendered because they lived inside `MeetingNotes`).
4. Typing a comment and clicking "Send" (or pressing Cmd/Ctrl+Enter) posts the comment; the textarea clears; the new comment appears in the list without a page reload.
5. Comments display author name, a role badge (Owner/Admin/Closer), a relative timestamp ("2 min ago"), and the body text.
6. Any URL in a comment body (starting with `http://`, `https://`, or `www.`) is rendered as a clickable `<a>` with `target="_blank"` and `rel="noopener noreferrer"`.
7. Comment authors see an "Edit" action in the `MoreHorizontal` menu on their own comments; clicking it swaps the content to an inline textarea with Save/Cancel buttons.
8. `tenant_admin` / `tenant_master` users see a "Delete" action on every comment; clicking it immediately soft-deletes (with a success toast); the comment disappears from the list.
9. Closer users do **not** see a "Delete" action on any comment (even their own).
10. A second browser tab viewing the same meeting receives new/edited/deleted comments in real-time via Convex's reactive subscription, without refresh.
11. Submitting a comment longer than 5,000 chars, or while offline, triggers an error toast; the textarea content is preserved for retry.
12. Keyboard: `Tab` reaches the textarea; focus moves back into the textarea after a successful submit; the inline edit textarea is `autoFocus`'d when opened.
13. `pnpm tsc --noEmit` passes.

---

## Subphase Dependency Graph

```
                     ┌── 2A (CommentContent — URL auto-linking) ────────────┐
                     │                                                       │
Phase 1 deployed ────┤                                                       │
                     │                                                       ├── 2C (CommentEntry) ───┐
                     ├── 2B (CommentInput)  ──────────────────────────────┐  │                        │
                     │                                                    │  │                        │
                     └────────────────────────────────────────────────────┴──┴── 2D (MeetingComments) ─┐
                                                                                                       │
                                                                        ┌──────────────────────────────┤
                                                                        │                              │
                                                              2E (closer client swap) ──┐              │
                                                                                        ├── Phase 2 ✓  │
                                                              2F (admin  client swap) ──┘              │
                                                                                                       │
                                                                                                       │
                                                                                                       ▼
                                                                                              Handoff to Phase 3
```

**Optimal execution:**
1. **Parallel start — 2A, 2B, 2C scaffold**:
   - 2A can start immediately (no backend dependency — pure render logic).
   - 2B can start as soon as the Phase 1 `addComment` mutation is callable (can even stub against a fake `useMutation` while Phase 1 finishes).
   - 2C depends on **2A only** (it imports `<CommentContent />`). It does not need `useMutation` — edit/delete handlers come in as props from 2D.
2. **After 2A + 2B + 2C merge → 2D**: assembles the card, wires `useQuery(getComments)`, `useMutation(deleteComment)`, and manages `editingId` state.
3. **After 2D merges → 2E and 2F in parallel**: swap `<MeetingNotes>` for `<MeetingComments>` in both page clients. They touch different files (`closer/.../meeting-detail-page-client.tsx` vs `pipeline/.../admin-meeting-detail-client.tsx`), so zero conflict risk.
4. Run the `expect` browser verification after 2E+2F.

**Estimated time:** 1–2 days (1 dev), or ~1 day with 2–3 agents running 2A/2B/2C concurrently.

---

## Subphases

### 2A — `CommentContent` (URL Auto-Linking Renderer)

**Type:** Frontend
**Parallelizable:** Yes — zero backend dependency; pure client-side render logic. Can start before Phase 1 finishes.

**What:** A presentational React component that takes plain-text `content` and renders it as a `<p>` with any URL substrings converted to secure `<a>` tags.

**Why:** The design (§5.2) keeps input as plain text and applies link detection at render time. This is simpler and cheaper than storing structured link data, and it means the Phase 4 notes migration automatically inherits linking without any backfill work.

**Where:**
- `app/workspace/closer/meetings/_components/comment-content.tsx` (new)

**How:**

```tsx
// Path: app/workspace/closer/meetings/_components/comment-content.tsx
"use client";

import { Fragment } from "react";

// Match http(s):// or www. prefixed URLs up to the next whitespace / bracket /
// quote. Excludes common trailing punctuation-as-sentence-terminator cases.
const URL_REGEX = /(?:https?:\/\/|www\.)[^\s<>)"'\]]+/gi;

type CommentContentProps = {
  content: string;
};

export function CommentContent({ content }: CommentContentProps) {
  const parts: Array<{ type: "text" | "link"; value: string }> = [];
  let lastIndex = 0;

  for (const match of content.matchAll(URL_REGEX)) {
    const matchIndex = match.index!;
    if (matchIndex > lastIndex) {
      parts.push({
        type: "text",
        value: content.slice(lastIndex, matchIndex),
      });
    }
    const url = match[0];
    parts.push({ type: "link", value: url });
    lastIndex = matchIndex + url.length;
  }

  if (lastIndex < content.length) {
    parts.push({ type: "text", value: content.slice(lastIndex) });
  }

  if (parts.length === 0) {
    // No URLs — render as plain text.
    return (
      <p className="whitespace-pre-wrap text-sm text-foreground">{content}</p>
    );
  }

  return (
    <p className="whitespace-pre-wrap text-sm text-foreground">
      {parts.map((part, i) =>
        part.type === "link" ? (
          <a
            key={i}
            href={
              part.value.startsWith("http")
                ? part.value
                : `https://${part.value}`
            }
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline underline-offset-2 break-all hover:text-primary/80"
          >
            {part.value}
          </a>
        ) : (
          <Fragment key={i}>{part.value}</Fragment>
        ),
      )}
    </p>
  );
}
```

**Key implementation notes:**
- Regex intentionally excludes `<>)"'\]` to avoid greedy matches when a URL is embedded in parentheses or quotes.
- `target="_blank"` + `rel="noopener noreferrer"` are mandatory — prevents window-opener attacks and preserves the referrer policy.
- `whitespace-pre-wrap` preserves user-entered newlines without requiring `<br />` insertion.
- `break-all` on the `<a>` prevents long URLs (e.g., `https://...?utm_source=…`) from blowing out the card width.
- This component is **pure** — no props other than `content`. No `useState`, no `useEffect`. Fully memoizable if profiling shows a hot path.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/_components/comment-content.tsx` | Create | Pure render component. |

**Side effects:** None. No network, no state.

---

### 2B — `CommentInput` (Textarea + Submit)

**Type:** Frontend
**Parallelizable:** Yes — depends only on Phase 1's `addComment` mutation type. Can be built against the real API as soon as Phase 1 deploys.

**What:** A form component that owns the textarea + submit button, calls `api.closer.meetingComments.addComment`, and handles Cmd/Ctrl+Enter submission.

**Why:** The primary write path. Extracted from the main card so the card stays focused on list rendering + state coordination.

**Where:**
- `app/workspace/closer/meetings/_components/comment-input.tsx` (new)

**How:**

```tsx
// Path: app/workspace/closer/meetings/_components/comment-input.tsx
"use client";

import { useCallback, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { SendIcon } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

type CommentInputProps = {
  meetingId: Id<"meetings">;
};

export function CommentInput({ meetingId }: CommentInputProps) {
  const [content, setContent] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const addComment = useMutation(api.closer.meetingComments.addComment);

  const handleSubmit = useCallback(async () => {
    const trimmed = content.trim();
    if (!trimmed || isSubmitting) return;

    setIsSubmitting(true);
    try {
      await addComment({ meetingId, content: trimmed });
      setContent(""); // Clear on success only.
      textareaRef.current?.focus();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to post comment",
      );
    } finally {
      setIsSubmitting(false);
    }
  }, [content, meetingId, addComment, isSubmitting]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  return (
    <div className="flex gap-2">
      <Textarea
        ref={textareaRef}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Add a comment… (Cmd+Enter to send)"
        className="min-h-[80px] resize-y"
        aria-label="New comment"
        disabled={isSubmitting}
      />
      <Button
        size="icon"
        onClick={handleSubmit}
        disabled={!content.trim() || isSubmitting}
        className="shrink-0 self-end"
        aria-label="Post comment"
      >
        <SendIcon className="size-4" />
      </Button>
    </div>
  );
}
```

**Key implementation notes:**
- `useState` is used deliberately (not React Hook Form) — this is a single-field form; RHF would be overhead. The established codebase pattern (AGENTS.md "Form Patterns") applies to multi-field dialogs, not single-textarea inputs.
- `setContent("")` only on success — on failure, the user's typed text is preserved so they can retry (addresses design §12.5 — network failure on submit).
- `setIsSubmitting(true/false)` blocks double-submits (design §12.2).
- `aria-label` on both textarea and button — design §11 references accessibility; the `web-design-guidelines` skill will verify during audit.
- No client-side length check — server-side validation in `addComment` is authoritative; if exceeded, the catch block surfaces the server's error message.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/_components/comment-input.tsx` | Create | Single-responsibility: post a comment. |

**Side effects:** Opens one Convex WebSocket channel for the mutation; closes on unmount. Standard behavior for `useMutation`.

---

### 2C — `CommentEntry` (Individual Comment Card)

**Type:** Frontend
**Parallelizable:** Yes — imports 2A (`<CommentContent />`) only. Edit/delete handlers come as props from 2D.

**What:** A row component rendering one comment: avatar, author name, role badge, timestamp, body (via `CommentContent`), "(edited)" marker, and hover-revealed action menu (Edit / Delete).

**Why:** Encapsulates per-item presentation + action wiring so 2D's main card stays lean. Holds the inline-edit state locally (swaps body for textarea + Save/Cancel buttons).

**Where:**
- `app/workspace/closer/meetings/_components/comment-entry.tsx` (new)

**How:**

**Step 1: Scaffold the component with read-only display.**

```tsx
// Path: app/workspace/closer/meetings/_components/comment-entry.tsx
"use client";

import { useCallback, useState } from "react";
import { useMutation } from "convex/react";
import { formatDistanceToNow } from "date-fns";
import {
  MoreHorizontalIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useRole } from "@/components/auth/role-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";

import { CommentContent } from "./comment-content";

type CommentEntryProps = {
  comment: {
    _id: Id<"meetingComments">;
    content: string;
    createdAt: number;
    editedAt?: number;
    authorName: string;
    authorRole?: "tenant_master" | "tenant_admin" | "closer";
    isOwn: boolean;
  };
  onDelete: (commentId: Id<"meetingComments">) => void;
};

const ROLE_LABEL: Record<
  NonNullable<CommentEntryProps["comment"]["authorRole"]>,
  string
> = {
  tenant_master: "Owner",
  tenant_admin: "Admin",
  closer: "Closer",
};

export function CommentEntry({ comment, onDelete }: CommentEntryProps) {
  const { isAdmin } = useRole();
  const editComment = useMutation(api.closer.meetingComments.editComment);

  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(comment.content);
  const [isSaving, setIsSaving] = useState(false);

  const canEdit = comment.isOwn;
  const canDelete = isAdmin;
  const hasActions = canEdit || canDelete;

  const handleStartEdit = useCallback(() => {
    setEditValue(comment.content);
    setIsEditing(true);
  }, [comment.content]);

  const handleCancelEdit = useCallback(() => {
    setIsEditing(false);
    setEditValue(comment.content);
  }, [comment.content]);

  const handleSaveEdit = useCallback(async () => {
    const trimmed = editValue.trim();
    if (!trimmed || trimmed === comment.content || isSaving) {
      setIsEditing(false);
      return;
    }
    setIsSaving(true);
    try {
      await editComment({ commentId: comment._id, content: trimmed });
      setIsEditing(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to save edit",
      );
    } finally {
      setIsSaving(false);
    }
  }, [editValue, comment.content, comment._id, editComment, isSaving]);

  return (
    <div className="group flex gap-3 py-3">
      <div
        aria-hidden
        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-foreground"
      >
        {comment.authorName.charAt(0).toUpperCase()}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">
            {comment.authorName}
          </span>
          {comment.authorRole && (
            <Badge
              variant="outline"
              className="px-1.5 py-0 text-[10px]"
            >
              {ROLE_LABEL[comment.authorRole]}
            </Badge>
          )}
          <span className="text-xs text-muted-foreground">
            {formatDistanceToNow(comment.createdAt, { addSuffix: true })}
          </span>
          {comment.editedAt && (
            <span className="text-[10px] italic text-muted-foreground">
              (edited)
            </span>
          )}

          {hasActions && !isEditing && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="ml-auto size-6 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                >
                  <MoreHorizontalIcon className="size-3.5" />
                  <span className="sr-only">Comment actions</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {canEdit && (
                  <DropdownMenuItem onClick={handleStartEdit}>
                    <PencilIcon className="mr-2 size-3.5" />
                    Edit
                  </DropdownMenuItem>
                )}
                {canDelete && (
                  <DropdownMenuItem
                    onClick={() => onDelete(comment._id)}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2Icon className="mr-2 size-3.5" />
                    Delete
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        <div className="mt-1">
          {isEditing ? (
            <div className="flex flex-col gap-2">
              <Textarea
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                className="min-h-[60px] resize-y"
                autoFocus
                aria-label="Edit comment"
                disabled={isSaving}
              />
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleCancelEdit}
                  disabled={isSaving}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={handleSaveEdit}
                  disabled={!editValue.trim() || isSaving}
                >
                  Save
                </Button>
              </div>
            </div>
          ) : (
            <CommentContent content={comment.content} />
          )}
        </div>
      </div>
    </div>
  );
}
```

**Key implementation notes:**
- Inline edit lives here (design §5.7) — modal-free editing. `useState` local to the row, so multiple edits on different rows don't interfere.
- `focus-visible:opacity-100` on the action button — keyboard users can reach the menu even though the `group-hover:opacity-100` pattern hides it for mouse users.
- `useRole().isAdmin` decides delete visibility — this is **UI gating only**; the Phase 1 `deleteComment` mutation re-validates server-side.
- `ROLE_LABEL` map makes role display deterministic and translates backend enum values to human-friendly labels.
- Delete handler comes in as a prop (`onDelete`) rather than being a `useMutation` here — keeps 2D as the single owner of the delete toast + loading state coordination.
- We intentionally don't wire an inline undo on delete — the soft-delete is recoverable server-side if needed, but no UX surface for it in MVP.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/_components/comment-entry.tsx` | Create | Imports `CommentContent` (2A). |

**Side effects:**
- Opens a `useMutation(editComment)` channel per rendered entry. Convex's client multiplexes these, so no per-row socket cost.

---

### 2D — `MeetingComments` (Main Card)

**Type:** Frontend
**Parallelizable:** No (within Phase 2) — depends on 2A, 2B, 2C being available as imports.

**What:** The top-level card that `useQuery(getComments)`s the list, manages delete coordination, and renders `<CommentsList>` + `<CommentInput>`. This is the single component that the page clients import.

**Why:** Consolidates subscription + delete mutation + loading/empty states in one place so page clients only render `<MeetingComments meetingId={meeting._id} />`.

**Where:**
- `app/workspace/closer/meetings/_components/meeting-comments.tsx` (new)

**How:**

```tsx
// Path: app/workspace/closer/meetings/_components/meeting-comments.tsx
"use client";

import { useCallback } from "react";
import { useMutation, useQuery } from "convex/react";
import { MessageSquareIcon } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";

import { CommentEntry } from "./comment-entry";
import { CommentInput } from "./comment-input";

type MeetingCommentsProps = {
  meetingId: Id<"meetings">;
};

export function MeetingComments({ meetingId }: MeetingCommentsProps) {
  const comments = useQuery(api.closer.meetingComments.getComments, {
    meetingId,
  });
  const deleteComment = useMutation(api.closer.meetingComments.deleteComment);

  const handleDelete = useCallback(
    async (commentId: Id<"meetingComments">) => {
      try {
        await deleteComment({ commentId });
        toast.success("Comment deleted");
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to delete comment",
        );
      }
    },
    [deleteComment],
  );

  const isLoading = comments === undefined;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <MessageSquareIcon
            className="size-4 text-muted-foreground"
            aria-hidden
          />
          <CardTitle className="text-base">Comments</CardTitle>
          {!isLoading && comments.length > 0 && (
            <span className="text-xs text-muted-foreground">
              ({comments.length})
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {isLoading ? (
          <div
            className="flex items-center justify-center py-6"
            role="status"
            aria-label="Loading comments"
          >
            <Spinner className="size-5" />
          </div>
        ) : comments.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No comments yet. Be the first to add one.
          </p>
        ) : (
          <div className="max-h-[400px] divide-y overflow-y-auto">
            {comments.map((comment) => (
              <CommentEntry
                key={comment._id}
                comment={comment}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}

        <CommentInput meetingId={meetingId} />
      </CardContent>
    </Card>
  );
}
```

**Key implementation notes:**
- `useQuery(..., { meetingId })` is automatically reactive — Convex pushes updates whenever any mutation touches a matching `meetingComments` row. No manual refetch.
- `max-h-[400px] overflow-y-auto` matches the design's open-question resolution (design §13, question 7).
- Empty state copy ("No comments yet. Be the first to add one.") is intentional — closers (who are the primary authors) see this on fresh meetings and immediately know what to do.
- The count badge "(3)" appears only after loading completes, to avoid a flash of "(0)" during the initial query.
- `role="status"` on the loading container is required by `web-design-guidelines` for screen reader announcements.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/_components/meeting-comments.tsx` | Create | Top-level card. Imports 2B, 2C. |

**Side effects:**
- **New subscription**: one reactive `getComments` query opens per mounted meeting detail page. Subscription closes on navigation away. Zero cost on meetings with zero comments (still fires the query but returns `[]`).
- **Behavioral change from old notepad**: the old `MeetingNotes` auto-saved on debounce (~800ms). Comments require an explicit submit. Document this in the release note so closers aren't surprised.

---

### 2E — Wire Into Closer Meeting Detail Page

**Type:** Frontend
**Parallelizable:** Yes (with 2F) — both swap files are independent.

**What:** Replace `<MeetingNotes ... />` with `<MeetingComments meetingId={meeting._id} />` in the closer detail page client. Remove the now-unused `MeetingNotes` import.

**Why:** Activates the new UI for closers.

**Where:**
- `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx` (modify, around lines 280–284)

**How:**

**Step 1: Update the import.**

```tsx
// Path: app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx

// BEFORE (find near top of file):
import { MeetingNotes } from "../../_components/meeting-notes";

// AFTER:
import { MeetingComments } from "../../_components/meeting-comments";
```

**Step 2: Replace the render site (around lines 280–284).**

```tsx
// BEFORE:
<MeetingNotes
  meetingId={meeting._id}
  initialNotes={meeting.notes ?? ""}
  meetingOutcome={meeting.meetingOutcome}
/>

// AFTER:
<MeetingComments meetingId={meeting._id} />
```

**Step 3: Verify no other references to `MeetingNotes` remain in the file.**

```bash
pnpm tsc --noEmit
```

**Key implementation notes:**
- The `meeting.notes` and `meeting.meetingOutcome` fields on the meeting record are still present in the Convex query response — they just aren't passed to a component anymore. This is fine; Phase 3 will formally deprecate them.
- No other prop wiring on the surrounding JSX changes. The containing `<Card>` grid layout continues to render Comments where Notes used to live — visually, users see a new card in the same slot.
- If any sibling code references the old `MeetingNotes`'s `meetingOutcome` prop (e.g., a status badge elsewhere on the page), note it and coordinate with Phase 3. The exploration found no such usage on the page client.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx` | Modify | Swap import + render. |

**Side effects:**
- **User-visible**: the outcome dropdown disappears from the closer view in this commit (because it was rendered inside `MeetingNotes`). The `updateMeetingOutcome` backend mutation still exists; it's just no longer callable from this UI. Phase 3 formally removes it.
- **PostHog `meeting_outcome_set` event** stops firing from this page (the event was emitted inside `MeetingOutcomeSelect`, which is no longer rendered). If the event is aggregated in any PostHog dashboard, it will show zero new events starting this deploy — flag for product analytics team.

---

### 2F — Wire Into Admin Meeting Detail Page

**Type:** Frontend
**Parallelizable:** Yes (with 2E) — different file, zero conflict.

**What:** Replace `<MeetingNotes ... />` with `<MeetingComments meetingId={meeting._id} />` in the admin detail page client.

**Why:** Activates the new UI for admins.

**Where:**
- `app/workspace/pipeline/meetings/[meetingId]/_components/admin-meeting-detail-client.tsx` (modify, around lines 256–260)

**How:**

**Step 1: Update the import.**

```tsx
// Path: app/workspace/pipeline/meetings/[meetingId]/_components/admin-meeting-detail-client.tsx

// BEFORE:
import { MeetingNotes } from "@/app/workspace/closer/meetings/_components/meeting-notes";

// AFTER:
import { MeetingComments } from "@/app/workspace/closer/meetings/_components/meeting-comments";
```

> **Note:** The admin page imports the component from the closer's `_components` directory. This is intentional — the design (§5) mandates admin + closer parity using the same component. Keep the import path stable when Phase 3 deletes the old `meeting-notes.tsx` file.

**Step 2: Replace the render site (around lines 256–260).**

```tsx
// BEFORE:
<MeetingNotes
  meetingId={meeting._id}
  initialNotes={meeting.notes ?? ""}
  meetingOutcome={meeting.meetingOutcome}
/>

// AFTER:
<MeetingComments meetingId={meeting._id} />
```

**Step 3: Verify.**

```bash
pnpm tsc --noEmit
```

**Key implementation notes:**
- Mirror-image of 2E. Intentionally kept as a separate subphase because the files are in different route directories and different reviewers may own them.
- Admin users will see the `(Admin)` / `(Owner)` role badges on their own comments now — they didn't see themselves annotated previously.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/pipeline/meetings/[meetingId]/_components/admin-meeting-detail-client.tsx` | Modify | Swap import + render. |

**Side effects:**
- Same as 2E but scoped to the admin view. No additional surprises.

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `app/workspace/closer/meetings/_components/comment-content.tsx` | Create | 2A |
| `app/workspace/closer/meetings/_components/comment-input.tsx` | Create | 2B |
| `app/workspace/closer/meetings/_components/comment-entry.tsx` | Create | 2C |
| `app/workspace/closer/meetings/_components/meeting-comments.tsx` | Create | 2D |
| `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx` | Modify | 2E |
| `app/workspace/pipeline/meetings/[meetingId]/_components/admin-meeting-detail-client.tsx` | Modify | 2F |

---

## Cross-Phase Side Effects

| System | Effect | Mitigation |
|---|---|---|
| Legacy `MeetingNotes` component | Still exists on disk, but no longer imported anywhere after 2E + 2F. TypeScript won't complain. | Phase 3 deletes the file. Don't delete in Phase 2 — keeps the diff reviewable and rollback possible. |
| `MeetingOutcomeSelect` component | Still exists on disk; no longer rendered (it lived inside `MeetingNotes`). | Phase 3 deletes the file. |
| `meeting.notes` field | Still queried by the meeting detail page (the field remains on the returned Doc), just unused by components. | Phase 4 migrates the data. No cleanup in Phase 2. |
| `meeting.meetingOutcome` field | Same — returned by queries but unused by UI. | Phase 3 deletes all write paths. Schema field removal deferred (requires `convex-migration-helper`). |
| `updateMeetingNotes` mutation | No longer called from any UI. Still exists in `convex/closer/meetingActions.ts`. | Phase 3 deletes the mutation. Calendly webhook pipeline writes `notes` directly via `ctx.db.insert` — **not** through this mutation — so deleting it is safe. |
| `updateMeetingOutcome` mutation | No longer called from any UI. | Phase 3 deletes. |
| PostHog `meeting_outcome_set` | Stops firing starting this deploy. | Note in release communication. If any PostHog funnels reference this event, flag for product analytics. |
| Lead meetings tab (`lead-meetings-tab.tsx`) | Still shows the "Outcome" column — unchanged in Phase 2, untouched by the comment swap. | Phase 3 removes the column. |
| Reactive query subscriptions | +1 subscription per open meeting detail page (`getComments`). | Negligible cost; auto-closes on navigation. Convex multiplexes WS frames. |
| Convex function count | +4 functions exposed on `api.closer.meetingComments`. | Cosmetic; no quota pressure. |
| Accessibility | New keyboard path (Cmd/Ctrl+Enter to submit), focus management on inline edit. | `expect` skill runs WCAG audit at phase close. |

---

## Verification Checklist (before closing Phase 2)

- [ ] `pnpm tsc --noEmit` passes.
- [ ] Closer page: post a comment → appears without refresh.
- [ ] Closer page: post a comment in tab A → it appears in tab B (same meeting) within ~1 second.
- [ ] Closer page: edit own comment → `(edited)` badge appears.
- [ ] Closer page: no "Delete" action visible on the hover menu.
- [ ] Admin page: same flows + "Delete" action is visible on every comment.
- [ ] Admin page: delete a comment → disappears from both tabs.
- [ ] URL `https://example.com/path?q=1` in a comment renders as a clickable link opening in a new tab.
- [ ] URL `www.example.com` renders as a clickable link (gets `https://` prefix).
- [ ] Submitting a 5,001-char comment → error toast with the limit message.
- [ ] Submitting with the network disabled → error toast; textarea content preserved.
- [ ] `expect` browser verification: accessibility audit passes; no console errors; screenshots at mobile/tablet/desktop/wide viewports.
- [ ] Old `MeetingNotes` and `MeetingOutcomeSelect` components are no longer imported anywhere (confirmed by grep) — **but not yet deleted** (that's Phase 3).
