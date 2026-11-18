# Automatic results

The CRM can propose a result, and for a kind the owner has promoted, record it with no person. Two sources feed it: a Whop payment (`docs/agents/payments.md`) and a recorded call's evidence (`docs/agents/call-insights.md`). Code lives in `convex/automation/`. The owner's screen is Settings › Automatic results (`/workspace/settings/automatic-results`).

Everything is off until the owner turns it on. With every kind off, no decision is derived or stored, readings use today's prompt, and the manual save paths behave as before, with two exceptions that apply to every tenant: a side-deal void now runs through the payment exclusion (`docs/agents/payments.md`), and every payment save checks the capacity hold (40 payment rows on a deal, 100 deals on a person).

## Kinds and levels

| Kind | Source | What it writes |
| --- | --- | --- |
| `payment_win` | Whop payment | A first payment on a deal, which wins it |
| `additional_payment` | Whop payment | A later payment on a won deal, through a confirmed membership |
| `call_back` | Recorded call | A reminder to call or text back; the meeting is marked held |
| `payment_owed` | Recorded call | A payment-owed reminder with the promised amount and date; held |
| `refusal_loss` | Recorded call | The deal closed lost with the reserved reason `call_refusal`; held |

The paid-on-call alert is not a kind. It is a question to the closer and never records anything.

Each kind has a level in `tenants.resultAutomation`:

- **off**: nothing is derived.
- **shadow**: the decision is stored and nobody sees it. It exists to be graded.
- **ask**: one tap for a person. The tap runs today's human core, so guards, the actor and the Second opinion queue behave as they do for a manual save.
- **automatic**: the system writes. Reachable only through `certificates.promoteKind`.

`settings.effectiveKindMode` is the one reader. It returns `off` when settings are absent, automation is not enabled, or (for the call kinds) Call insights is off. It returns `ask` in place of `automatic` when the kind's breaker is tripped or its certificate is not for the current rule version. `pausedAt` records the last pause and stays after a resume: `enabled` alone says whether automation is running.

## Rules

- **People first.** Every path where a person records a result calls `noteHumanResult` once, in the same mutation. It bumps `opportunities.humanResultRevision` and stops the deal's outstanding decisions. A new human result path needs the call. System paths (Calendly, the stale job, automatic Fathom matching) must not make it.
- **A decision is derived, never typed.** `derive.ts` (payments) and `callRule.ts` (calls) are pure. `decisions.ts` and `callDecisions.ts` load the facts, hash them into `inputKey`, and read and insert in one mutation, so the same input yields one row. Every writer re-derives inside its own mutation and writes only if the key still matches.
- **Words never leave runs.** Decisions, receipts, notices, pinned lines, events and logs hold ids, fixed codes, numbers and digests. Quotes are read from `callInsightRuns` at query time for the meeting page, through `maskEvidenceQuotes`.
- **Money never marks attendance.** A win from Whop leaves the meeting scheduled and sets `meetings.attendanceOwedSince`. The closer answers with `recordAttendanceOnly`, which never moves the deal and, by design, queues no Second opinion: the deal's result came from Whop, not from the closer.
- **No standalone held.** A call is marked held only together with a call-back, a payment-owed task or a refusal, with `attendanceSource: "call_insights"` and `attendanceDecisionId`.
- **A stop stays stopped.** A person's stop is stored under a veto key that survives a re-read, a reprojection and a policy change. `stood_down` is the gate that keeps it from coming back.
- **Automatic needs a certificate.** `setKindMode` cannot set `automatic`. `promoteKind` (owner only) writes the certificate pointer and the level together, and refuses a sample that is not certified for this kind and the current rule version. Every executor calls `breaker.assertAutomaticAllowed` inside its own mutation.
- **A row with no recorder is an automatic write.** `lib/paymentWrite.ts` `insertAutomaticPayment` is the only writer, and it requires a ready automatic decision for the same tenant, payment and deal.
- **A refusal is never silent.** Under automatic, a refusal raises a notice. Nothing changes until the assigned closer acknowledges it, or an owner or admin takes responsibility. The period (`refusalNoticeHours`, 48 by default) runs from that acknowledgment. `notice.finalizeRefusal` re-checks fifteen conditions before it writes; a payment for the person cancels it.

## The gate

A certificate is a frozen sample (`automationSamples`) of decisions the rule would have written, one per person, graded by a human. Targets: 300 for `payment_win`, `additional_payment` and `refusal_loss`; 60 for `call_back` and `payment_owed`. One wrong case or one unresolved unsure fails the sample. Abstentions are graded separately and never fill it. A rule version change lapses the certificate; for call kinds the version includes the prompt, the model and the check versions.

Grading is blind: `grading.listToGrade` returns evidence only, the grader commits an answer, and `reveal` shows the proposal. A grader who reveals first is recorded, and the panel reports it.

After promotion, `audit.ts` selects the first 10 automatic writes of a kind and then one in five, by a hash of the decision id. A canary left open for a business day, or a sampled write for 7 days, trips the breaker. So does one audited wrong person, wrong deal or false loss, and, for payment kinds, a "This isn't my sale" flag left unanswered for a business day. A wrong amount, type or program holds only that product's mapping.

## Putting a result right

- **Payments**: `payments/exclude.ts` and `payments/restore.ts` (see `docs/agents/payments.md`).
- **Tasks set from a call**: `taskCorrections.changeNextStep` and `callDidNotHappen`. The second withdraws the held mark through `lib/meetingAttendanceUndo.ts`, the only caller of the `automation_held_undone` meeting exception, and corrects the person's lifecycle with `attendance_withdrawn`.
- **Refusals**: `refusal.reopenRefusal` moves the deal to Follow-up with a reminder due now through `call_refusal_reopened`. It needs the applied refusal decision, so a loss a person typed is never reopened this way.
- **Automatic writes**: `undo.undoAutomaticWrite`, allowed while nothing a person did has touched the deal since.

## Tests

`convex/automation/*.test.ts`, the scenarios in `convex/payments/scenarios/`, and two invariant checkers that every scenario runs after each step: `tests/paymentInvariants.ts` and `tests/automationInvariants.ts`. A new write path should run both.

## Not verified

Nothing here has run against a live Whop account or a production call. The new reading prompt has not been run against the live AI gateway: `callInsights/eval/promptSmoke` does that on a dev deployment and costs a few dollars. Real concurrent writes are covered by `scripts/whop-concurrency-run.mjs`, which has not been run.
