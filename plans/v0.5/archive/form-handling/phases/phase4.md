# Phase 4 — Follow-Up Dialog Assessment (No Migration)

**Goal:** Assess the Follow-Up Dialog (`follow-up-dialog.tsx`) for RHF/Zod migration eligibility and confirm it does not benefit from migration. The dialog is a **state-machine UI** (idle → loading → success | error) with zero user-editable form fields — it is not a form. After this phase, the assessment is documented and the dialog remains unchanged.

**Prerequisite:** Phase 1 complete (infrastructure). No dependency on Phases 2 or 3 — this is an independent assessment.

**Runs in PARALLEL with:** Phases 2, 3, and 5 — this phase has no code changes and no shared files.

**Skills to invoke:**
- `expect` — Verify the dialog still works end-to-end after the other phases' migrations (regression check)

**Acceptance Criteria:**
1. The Follow-Up Dialog source file is unchanged — zero code modifications to `follow-up-dialog.tsx`.
2. The dialog continues to function identically: idle → click "Generate" → loading → success (copy link) | error (retry).
3. The 5 existing `useState` hooks are confirmed as UI state only (no field values that RHF could manage).
4. Zero user-editable input fields are present — the dialog's only interaction is button clicks.
5. This phase plan documents the skip rationale with a concrete migration-criteria checklist.
6. `pnpm tsc --noEmit` passes without errors (trivially — no changes).

---

## Subphase Dependency Graph

```
4A (Code review & eligibility check) ──→ 4B (Confirm no-migration decision) ──→ 4C (Regression verify)
```

**Optimal execution:**
1. Start 4A — open the dialog source, audit each `useState` and JSX element against migration criteria.
2. Once 4A completes → 4B — record the formal skip decision with the criteria checklist.
3. Once 4B completes → 4C — run the dialog in the browser to confirm no regressions from other phases.

**Estimated time:** 15–30 minutes

---

## Subphases

### 4A — Code Review and Eligibility Audit

**Type:** Manual
**Parallelizable:** No — must complete first. The audit determines whether any code changes are needed.

**What:** Open `follow-up-dialog.tsx`, enumerate every `useState` hook and every rendered input/select/textarea, and classify each as "UI state" or "form field state".

**Why:** The design document identifies this dialog as a state-machine, but the phase plan must independently verify this with a concrete code audit — not just repeat the design doc's conclusion. If the dialog gained a form field since the design was written, this audit catches it.

**Where:**
- `app/workspace/closer/meetings/_components/follow-up-dialog.tsx` (read-only — no changes)

**How:**

**Step 1: Open the file and locate all useState hooks**

```typescript
// Path: app/workspace/closer/meetings/_components/follow-up-dialog.tsx
// Lines 59–63 — all 5 useState hooks:

const [open, setOpen] = useState(false);                    // UI: dialog visibility
const [state, setState] = useState<DialogState>("idle");     // UI: dialog mode (idle/loading/success/error)
const [bookingUrl, setBookingUrl] = useState("");            // UI: result from backend action
const [error, setError] = useState("");                      // UI: error message from action failure
const [copied, setCopied] = useState(false);                 // UI: clipboard copy feedback
```

**Step 2: Classify each hook**

| Hook | Category | RHF Replaceable? | Reason |
|---|---|---|---|
| `open` | Dialog visibility | No | RHF doesn't manage dialog open/close state |
| `state` | UI mode (state machine) | No | RHF manages form fields, not UI flow states |
| `bookingUrl` | Backend result | No | Set by `createFollowUp` action return value — not user input |
| `error` | Action-level error | No | Not a validation error — it's a runtime failure message |
| `copied` | Clipboard feedback | No | Transient UI flag for "Copied!" text, resets after timeout |

**Step 3: Scan JSX for user-editable elements**

Search the render output for any `<Input>`, `<Select>`, `<Textarea>`, or `<form>` tags:

- **Line ~120:** `<InputGroupInput>` — this is a **read-only** input displaying the generated booking URL. It has `readOnly` attribute. The user cannot type in it.
- **No `<form>` tag** — the dialog has no form submission. The "Generate" button calls an action directly via `onClick`.
- **No `<Select>` or `<Textarea>`** — no user choices or freeform input.

**Result:** Zero user-editable form fields. All interaction is via buttons (Generate, Copy, Retry, Close).

**Key implementation notes:**
- The read-only `<InputGroupInput>` for the booking URL might look like a form field at first glance, but it's purely display — the value comes from the backend, not from user typing.
- The `<Alert>` for errors is action-level (network/Convex failure), not validation-level. No `<FormMessage>` equivalent is needed.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| _(none)_ | — | Read-only audit — no changes |

---

### 4B — Document No-Migration Decision

**Type:** Manual
**Parallelizable:** No — depends on 4A (audit results).

**What:** Formally record the skip decision by evaluating the dialog against the 4 RHF/Zod migration criteria from the design document.

**Why:** Future developers or agents reviewing the form-handling plan need to understand why this dialog was excluded. A documented decision with a concrete checklist is faster to review than re-reading the source file.

**Where:**
- This phase plan document (you're reading it)

**How:**

**Step 1: Evaluate migration criteria**

| # | Migration Criterion | Result | Evidence |
|---|---|---|---|
| 1 | Has user-editable input fields? | **No** | All 5 `useState` hooks are UI state. The `<InputGroupInput>` is read-only. |
| 2 | Has manual validation logic in submit handler? | **No** | No submit handler exists. The "Generate" button calls a Convex action directly. |
| 3 | Would benefit from inline error display (`<FormMessage>`)? | **No** | Errors are action-level (network/backend), not field-level. The `<Alert>` component is appropriate. |
| 4 | Has `useState` hooks managing field values that RHF could replace? | **No** | All 5 hooks serve UI purposes: dialog mode, result display, clipboard feedback. |

**Decision: No migration.** 0 of 4 criteria met. The dialog is not a form.

**Step 2: Note future redesign scope**

This dialog will be **completely redesigned** in v0.5 Phase 4 (Follow-Up & Rescheduling Overhaul) from `plans/v0.5/version0-5.md`. The redesigned version will be a two-path dialog:

- **"Send Link" path** — similar to current, but uses the closer's personal Calendly event type with UTM params
- **"Set Reminder" path** — a real form with:
  - Reminder method select (call / text)
  - Date/time picker
  - Optional notes textarea

The "Set Reminder" path **will** use RHF + Zod when built. The infrastructure from Phase 1 will be ready.

**Key implementation notes:**
- The state-machine pattern (idle/loading/success/error) is orthogonal to form handling and is a clean, well-established pattern in this codebase.
- When the v0.5 Follow-Up Overhaul redesigns this dialog, the implementer should use the RHF + Zod patterns established in Phases 2, 3, and 5 for the new "Set Reminder" form fields.
- The "Send Link" path will likely remain a state-machine (no form fields), even after redesign.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| _(none)_ | — | Documentation only — no code changes |

---

### 4C — Regression Verification

**Type:** Manual
**Parallelizable:** No — should run after Phases 2, 3, and 5 are also complete to confirm no cross-dialog regressions.

**What:** Open the Follow-Up Dialog in the browser and verify it still works end-to-end. This catches any accidental regressions from the other phases' import changes (e.g., if a shared component was inadvertently modified).

**Why:** Although this dialog is not being migrated, the other dialogs in Phase 2/3/5 change import patterns (removing `Field`/`FieldLabel` imports, adding `Form`/`FormField` imports). If any shared utility was accidentally broken, this regression check catches it.

**Where:**
- Browser — `/workspace/closer/meetings/[meetingId]` route

**How:**

**Step 1: Type check**

```bash
# Path: project root
pnpm tsc --noEmit
```

Must pass with zero errors.

**Step 2: Browser verification**

Navigate to a meeting detail page as a closer and test the Follow-Up Dialog:

1. Click "Schedule Follow-up" → dialog opens in idle state.
2. Click "Generate Link" → loading spinner appears → success state shows booking URL.
3. Click "Copy" → URL copied to clipboard, button text changes to "Copied!".
4. Close and reopen the dialog → state resets to idle (not stale success/error).
5. (If possible) Trigger an error condition → error state shows with "Retry" button → click "Retry" → returns to loading.

**Step 3: Verify no import drift**

```bash
# Path: project root
# Confirm the follow-up dialog file is unchanged from before the form-handling feature
git diff HEAD -- app/workspace/closer/meetings/_components/follow-up-dialog.tsx
```

Output should be empty (no changes).

**Key implementation notes:**
- If the `expect` skill is available, use it for the browser verification — it provides accessibility audit and console error checking for free.
- The `git diff` check is a safety net — if someone accidentally touched this file during another phase, it surfaces immediately.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| _(none)_ | — | Verification only — no changes |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| _(none)_ | — | No files changed — assessment and verification only |

---

## Next Phase

Proceed to **Phase 5: Mark Lost & Role Edit Dialog Migration** — two simple dialogs that complete the form handling modernization for all existing workspace forms.
