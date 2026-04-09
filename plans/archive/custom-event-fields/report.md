# Custom event fields (Calendly booking form) — technical report

**Scope:** How answers to Calendly **event-type custom questions** (booking form) enter the CRM, where they are stored, and how they appear in the product UI.

**Date:** 2026-04-05

---

## Summary

- Calendly exposes invitee answers as **`questions_and_answers`** on the **`invitee.created`** webhook payload (nested under the envelope’s **`payload`** object).
- This app **extracts** those pairs and stores them on **`leads.customFields`** as a string-to-string map (question label → answer).
- The **UI does not render** `customFields` today. Closers only see **name, email, and phone** on the lead panel; form answers exist in the database only unless inspected via Convex or raw webhook storage.

---

## Calendly API behavior

Per local docs (mirroring Calendly’s webhook schema):

- The invitee payload includes **`questions_and_answers`**: an array (possibly empty) of **Invitee Question and Answer** objects.
- Documented shape includes at least **`question`** and **`answer`** (and optionally **`position`**). See `.docs/calendly/api-refrerence/webhooks/pure-api/get-sample-webhook-data.md`.

**Distinct from routing forms:** Calendly also emits **`routing_form_submission.created`** with its own **`questions_and_answers`**. That event type is **not** handled by the pipeline dispatcher (see “Gaps” below).

---

## Ingestion path

1. **HTTP webhook** — `convex/webhooks/calendly.ts` verifies the signature and persists the **raw JSON body** on the tenant’s webhook event record (`persistRawEvent`).
2. **Pipeline** — `convex/pipeline/processor.ts` parses the envelope, takes **`envelope.payload`** (the invitee object), and for **`invitee.created`** calls **`internal.pipeline.inviteeCreated.process`** with that object.

---

## Transformation and storage

**File:** `convex/pipeline/inviteeCreated.ts`

- **`extractQuestionsAndAnswers`** walks `payload.questions_and_answers`, requires non-empty **`question`** and **`answer`** on each item, and builds `Record<string, string>`.
- On **new lead:** `customFields` is set to that record (or omitted if empty).
- On **existing lead:** **`mergeCustomFields`** merges incoming keys into existing `customFields` (shallow merge: newer answers overlay same question keys).

**Schema:** `convex/schema.ts` — `leads.customFields` is `v.optional(v.any())` (flexible JSON; see `plans/vulnerabilities.md` VULN-08 for hardening options).

---

## UI status

**Finding:** No component reads **`lead.customFields`** for display.

**Primary surface:** Meeting detail uses **`LeadInfoPanel`** (`app/workspace/closer/meetings/_components/lead-info-panel.tsx`), which renders only **`fullName`**, **`email`**, and **`phone`**.

A repo-wide search shows **`customFields`** referenced only in Convex pipeline/schema/planning files—not under `app/`.

---

## Gaps and follow-ups

| Topic | Status |
|--------|--------|
| Event-type booking form answers | Stored on **`leads.customFields`** from **`invitee.created`** |
| Display in CRM UI | **Not implemented** |
| **`routing_form_submission.created`** | **Unhandled** by `processor.ts` switch (logged unhandled / marked processed per current default branch behavior) |
| Raw webhook payloads | Retained for audit/debug; full JSON available independent of `customFields` extraction |

**Product follow-up (if exposing form answers):** Add a section under **`LeadInfoPanel`** (or meeting detail) that safely renders **`lead.customFields`** when it is a plain object of string values; consider validation, empty states, and long-text wrapping for accessibility.

---

## Key file references

| Area | Path |
|------|------|
| Extraction & merge | `convex/pipeline/inviteeCreated.ts` |
| Webhook dispatch | `convex/pipeline/processor.ts` |
| Webhook ingestion | `convex/webhooks/calendly.ts` |
| Lead schema | `convex/schema.ts` (`leads`) |
| Lead sidebar UI | `app/workspace/closer/meetings/_components/lead-info-panel.tsx` |
| Calendly payload docs | `.docs/calendly/api-refrerence/webhooks/webhook-events-samples/webhook-payload.md` |
