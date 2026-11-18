# Payment providers (Whop)

A tenant can connect its Whop account. Whop's payments then arrive in the CRM as facts in `providerPayments`. A fact is not cash: no report reads these tables, and money counts only through a `paymentRecords` row, as it always has. A person can link a Whop payment to a payment someone already recorded by hand, as evidence; linking never creates a payment or wins a deal. A person can also confirm a Whop payment into a CRM payment, and a promoted kind records it with no person (`docs/agents/automatic-results.md`). Link, unlink, Seen and hold releases count in Activity.

Code lives in `convex/payments/`. The screens are Settings › Integrations › Whop (`/workspace/settings/whop`) and Billing › From Whop (`/workspace/billing/whop/[providerPaymentId]`).

## Tables

These tables live in `convex/payments/schema.ts`.

- `tenantPaymentConnections` holds credentials, dispute access, the pinned API version and sweep state.
  Each tenant can have one connected Whop environment. Settings offers Live and Sandbox when no environment is connected.
  Each environment stays tied to the account first saved there. Within an environment, a tenant keeps its claim on the account until it disconnects.
  Only internal functions read the key and secrets. `connection.getConnection` returns a masked view.
- `providerPayments`: one row per Whop payment, as last read. Keyed on tenant, connection and Whop's payment id.
- `paymentProviderBindings`: a Whop product mapped to a program, a Whop variant (price) mapped to a payment type, a membership a person confirmed mapped to a deal, and later a checkout mapped to a deal. A change inserts a new version and disables the old row.
- `paymentWebhookReceipts` holds a permanent receipt per delivery. The same write saves the capped raw body on the receipt. Retention clears the body after 7 days. Separate pending receipts track separate refund and dispute resources.

`paymentRecords` gains two optional fields: `providerPaymentId` and `providerPaidAt`.

## Rules

- **A provider payment is never cash.** Don't read `providerPayments` in a report, a total or an aggregate.
- **One active allocation.** `providerPayments.paymentRecordId` names the one CRM payment that counts for a Whop payment. `paymentRecords.providerPaymentId` is provenance and stays on a row after it stops counting, so two rows may cite the same Whop payment. Read the row that counts through the pointer, and query the `by_tenantId_and_providerPaymentId` index with `take()`, never `.unique()`.
- **Amount and time never tie anything together.** They don't choose the person, the deal or the manual payment. An identifier or a person does.
- **The matcher doesn't use `resolveLeadIdentity`.** This is a deliberate exception to the lead lifecycle ADR's rule 3. Outside bookings that function picks the first match, and it can write. `findPaymentTarget` (`match.ts`) is read-only: it creates nobody and never adds the payer's email to a person.
- **A link adds evidence.** Link and unlink leave cash, payment counts, deal counts and enrollments unchanged. The provider payment's `allocationRevision` starts at zero and advances on each link, unlink or void that clears an allocation. An unlink clears the CRM row's provenance. A side-deal void preserves provenance and releases the allocation. Clearing an allocation reclassifies the fact and disables up to 100 anchored membership bindings in the transaction. A continuation disables any remaining bindings.
- **Retries read the current allocation.** Link succeeds without a write if the requested record is already linked. Unlink does the same if the pointer is clear and the revision advanced exactly once. Other writes must match the displayed revision, and unlink also checks the displayed CRM record. Both return the current revision and record id.
- **Amount consent uses the two amounts on screen.** If Whop's total and the CRM amount differ, the link requires both acknowledged values to match their stored values. The mismatch response includes the current amounts so Billing can ask again.
- **Times.** `recordedAt` stays the time every report uses. `providerPaidAt` is when Whop collected the money and is shown, never bucketed.
- **Money.** Whop sends `total` as a decimal string with its own `decimals`. `whop/normalize.ts` converts it by exact string arithmetic. `totalMinor` is set only for two-decimal currencies; any other currency goes to a person as `unsupported_currency`. Don't use `toAmountMinor` here: it always multiplies by 100.
- **Personal data.** Normalized facts hold payer email and a phone that arrived with a country code. Email and phone expire 90 days after first seen for historical and non-actionable payments, and 180 days after first seen for payments awaiting review. Resolution shortens the deadline to 90 days after resolution if that is earlier. Expiry survives disconnect and a fresh read cannot restore cleared details. Logs, errors and event metadata carry IDs and fixed codes only.

## Intake

`POST /webhooks/whop?c=<connectionId>` (`webhook.ts`):

1. The connection id selects the secret and authorizes nothing by itself.
2. `signature.ts` checks the headers and signing material before the handler reads the body. The timestamp tolerance is five minutes, a request can carry up to eight signature candidates, and the raw body is capped at 256 KiB. Whop signs with the whole `ws_…` secret. Standard Webhooks `whsec_…` keys are base64-decoded. Each format requires 24 bytes of key material. A replaced secret keeps working for 24 hours. Invalid-signature warnings are sampled once per connection per minute.
3. The signed `account_id` or legacy `company_id` must equal the connection's account ID. Both fields must agree when both are present.
4. One mutation dedupes on the webhook id, writes the receipt and enqueues the work on `providerPool`, which is separate from the Calendly pool.

Every event means "read this payment again". `intake.ts` reads `GET /payments/{id}` and stores it in `storePaymentRead`:

- An older source revision or refresh generation cannot replace newer facts. A superseded receipt retries unless a later generation has already stored a source revision at least as new.
- A refund or dispute delivery sets `adverseFencedAt` and advances `adverseFenceRevision` as soon as the receipt attaches to its payment. A resource read and a canonical payment read settle that resource. Refunds are compared by magnitude because Whop can send signed amounts. The fence stays while a resource remains pending. A refund or dispute resource that returns HTTP 403 still triggers the canonical read if its payment id is known.
- Billing can release a stuck fence after checking Whop. Release checks the fence revision shown to the operator and refuses if more than 100 receipts are pending. In one transaction it clears the fence, resolves the pending receipts as `released_by_person`, and schedules a canonical refresh. An adverse result on that refresh fences the payment again.
- Receipts stop retrying when the connection is disconnected or the key is rejected. Sweeps resume from the connection's checkpoints after reconnect and revisit pending receipts for known payments. Whop's `Retry-After` accepts seconds or an HTTP date and is capped at 15 minutes.
- A re-read never overwrites the resolution (`leadId`, `opportunityId`, `paymentRecordId`, `matchMethod`, or a `reviewState` of `linked`, `recorded` or `dismissed`).
- After storing, `refreshProviderPaymentReview` recomputes where an unresolved payment stands.

`reconcile.ts` covers what webhooks miss:

| Cron | When | What |
| --- | --- | --- |
| `whop-payment-sweep` | every 15 minutes | Payments created, refunded or disputed since the last sweep, plus non-final facts, fenced facts and older provisional facts. Covers a 30-minute overlap |
| `whop-payment-full-scan` | 07:34 UTC | Every payment, paged across runs. Whop has no `updated_after`, and an old pending payment can turn paid |
| `whop-payment-retention` | 07:54 UTC | Clears raw bodies after 7 days and payer details at their indexed deadlines |

A payment detail that returns 404 or cannot be parsed is queued on its provider payment row. A superseded sweep read is also queued unless a newer stored revision covers it. Each recent sweep retries up to 25 due rows, oldest first. The delay starts at 15 minutes and doubles up to 24 hours. A stored read clears the retry fields. The sweeps stop retrying after 20 attempts, and Settings reports up to 100 exhausted payments per connection. A later webhook can still refresh an exhausted payment.

An indexed stage also revisits provisional facts older than 15 minutes. Indexed fence reads and Whop's recent refund and dispute filters keep terminal history out of these stages. A sweep's success timestamp is the end of the window it covered.

Provider-wide failures leave a checkpoint at the failing page. A run allows up to 64 pages across Workpool jobs and stops when it sees a repeated cursor in the run. A nightly sweep skips a busy lease.

All requests share a per-connection clock (`connectionState.reserveRequest`) and pin `Api-Version-Date` (`WHOP_API_VERSION_DATE` in `whop/client.ts`). Change the pin on purpose, with the normalizer's tests.

## Recording a Whop payment

- **One insert.** The four manual writers and the provider writer share `lib/paymentWrite.ts` `insertRecordedPayment`, which checks capacity (40 stored rows on a deal, disputed included; 100 deals for a person) before it inserts.
- **The manual writers ask first.** Each runs `reconcileCheck.checkPaymentReconciliation` after authorization and before its eligibility check. A Whop payment that may be the same money refuses the save with `payment.whop_payment_found` until the person answers: confirm it, "it's that payment", or "different money". The answer pins the payments the person saw, so one that arrived later is never declared different by accident.
- **A row created from Whop** has `origin` and `recordedVia` of `provider`, whoever confirmed it. A row a person typed and later linked keeps its own origin, so Team Performance still counts it as theirs.
- **`payments/apply.ts` `applyProviderPayment`** is the writer for Billing's confirm, the "they didn't attend" button and automatic writes. It repeats the manual writer's side effects in the same order and never touches attendance, proof or Second opinion.
- **Times.** `recordedAt` and the deal's `paymentReceivedAt` are the commit time, as for any late entry. Nothing is backdated.
- **A closer confirms only a live match.** A closer's confirmation, proof waiver or same-money link needs the matcher's current answer to name that exact deal, re-derived in the write. When it abstains (several open deals, a conflict, an excluded deal), the closer records a manual payment with proof and the Whop payment stays with Billing. Program, payment type and credit of a provider row come from the server's proposal.
- **A wrong-match veto holds.** A deal in `excludedOpportunityIds` takes that payment back only through restore. `setActiveAllocation` refuses every other caller.
- **Sandbox is never cash.** `allocation.ts` `sandboxAllocationBlocked` refuses to record, link or waive proof for a Sandbox fact, except on the development deployment or one that sets `WHOP_SANDBOX_RECORDING=allow` (the throwaway race-test deployment). Sandbox facts stay visible in Billing.
- **Memberships.** `bindings.ts` lets Billing confirm that a membership belongs to the deal its first payment counts for. Later charges on it then match as additional payments. Clearing that allocation disables the confirmation.
- **Whop-backed amounts aren't edited.** `billing/mutations.ts` `correctPayment` refuses an amount change on a row with `origin: "provider"`. Take it out and record the right one.

## Taking a payment out and putting it back

`payments/exclude.ts` is the one contract, whatever the cause (wrong match, refund, chargeback, a side-deal void). It looks at the payments that count afterwards:

- Another payment still counts: the deal stays won and `paymentReceivedAt` moves to the earliest one.
- None counts and nothing has happened since a Billing or automatic win: Undo returns the deal to where it was.
- None counts otherwise: the approval must choose. Closed lost with the reserved reason `payment_excluded`, or Follow-up with one reminder due now.

A won deal is never left with no counting payment, and every move off won clears `paymentReceivedAt` in the same transition. Attendance a person recorded is never touched. `payments/restore.ts` reverses a mistaken exclusion and refuses when the Whop payment now counts for another row. Both take a fingerprint from a preview; a retry returns `alreadyApplied` and anything that changed returns `stale_preview`. `lib/taskSettlement.ts` decides what happens to the deal's tasks in all three directions.

`payment_excluded` and `call_refusal` are reserved loss reasons (`opportunities/stages.ts`). Every path where a person types a reason calls `assertTypedLossReason`, and screens print them through `lib/lossReasonLabel.ts`.

## Where a payment stands

`reviewState` on `providerPayments`:

| State | Meaning |
| --- | --- |
| `not_actionable` | Not paid, or paid zero |
| `needs_person` | Paid, and no CRM payment counts for it yet. `reviewReason` says why |
| `linked` | A person tied it to a payment recorded by hand |
| `recorded` | The CRM payment that counts was created from it |
| `dismissed` | A person said it isn't money for a deal here. `dismissReason` says why |
| `historical` | Collected before the connection's `autoImportAfter` |

`match.ts` decides the reason in this order: an active allocation; a deal binding; else the payer's email must name exactly one surviving person, who must have exactly one open deal, counting every open deal, at Booked or Follow-up. Then the evidence checks: the deal existed when the money was collected, the payment is under 7 days old, it is one mapped line item, it isn't financed or a renewal, the deal has no unlinked manual payment, no other deal of the person has unlinked cash logged since the day before Whop collected the money (`capacity.ts` `otherDealCashHold`), and there is no refund or dispute. A read that hits its cap counts as ambiguous, never as "none".

`reviewReason: "ready"` means the rule found one person with one open deal. Whether a person confirms it or it is recorded automatically depends on the kind's level (`docs/agents/automatic-results.md`).

Billing shows the connected environment and badges sandbox facts. Waiting uses a live match for each of its 25 rows and flags rows whose classification was deferred when the read budget ran low. Linked, Dismissed and History are available as filters. Historical payments never appear as suggestions. Refunds and disputes on linked or recorded payments have a separate review list. Linking an adverse or fenced fact opens an item. Changes to the adverse state, an increased refund or a newly observed refund or dispute id advance the review revision. Seen checks that revision and the linked CRM record before clearing the item and recording an IDs-only Activity event.

The active environment supplies the Billing queues, detail review and review actions. Evidence on a CRM payment shows its original environment and whether its source is connected. You can open the Whop detail and unlink a manual link after disconnecting or switching environments.

## Known limits

- Billing defers live classification when its read budget runs low.
  A single match with large CRM records can still exceed the transaction budget.
- Request pacing, webhook tracking and sweep checkpoints write to the connection row.
  Concurrent work can contend there and rerun Billing subscriptions.
- Connect and rotate pass credentials as Convex function arguments.
  Convex diagnostics can include the arguments when validation fails before the handler runs.
- Phone conflict checks use normalized phone identifiers.
  They miss a phone saved only on a person's profile.

## Permissions

- Connect, rotate, disconnect and map: `settings:manage`.
- See the Billing view: `billing:view`. Link, dismiss and mark a refund or dispute seen: `billing:review`. Unlink, reopen and release a hold: `billing:correct`. All need Billing Ops enabled.

## Tests

`convex/payments/*.test.ts`, with synthetic fixtures in `tests/whopFixtures.ts` and `tests/providerPaymentFixtures.ts`. No real name, email or id belongs in a fixture.

## Not verified against Whop

The integration was built from Whop's published OpenAPI spec and SDK source. Until a real delivery and a sandbox purchase are observed, these stay open: whose email a payment carries, how each financing provider appears, and the smallest set of scopes that still delivers payment webhooks with the email filled in. `runbooks/whop-measurement.md` describes the read-only measurement that answers the first.
