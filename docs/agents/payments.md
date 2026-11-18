# Payment providers (Whop)

A tenant can connect its Whop account. Whop's payments then arrive in the CRM as facts in `providerPayments`. A fact is not cash: no report reads these tables, and money counts only through a `paymentRecords` row, as it always has. In this phase a person links a Whop payment to a payment someone already recorded by hand, as evidence. Linking never creates a payment or wins a deal. Link, unlink and Seen actions count in Activity.

Code lives in `convex/payments/`. The screens are Settings › Integrations › Whop (`/workspace/settings/whop`) and Billing › From Whop (`/workspace/billing/whop/[providerPaymentId]`).

## Tables

These tables live in `convex/payments/schema.ts`.

- `tenantPaymentConnections`: one connected Whop environment per tenant. Within an environment a Whop account belongs to one tenant until disconnected. Holds credentials, dispute access, the pinned API version and sweep state. Only internal functions read the key and secrets; `connection.getConnection` returns a masked view.
- `providerPayments`: one row per Whop payment, as last read. Keyed on tenant, connection and Whop's payment id.
- `paymentProviderBindings`: a Whop product mapped to a program, a Whop variant (price) mapped to a payment type, and later a membership or checkout mapped to a deal. A change inserts a new version and disables the old row.
- `paymentWebhookReceipts` holds a permanent receipt per delivery. The same write saves the capped raw body on the receipt. Retention clears the body after 7 days. Separate pending receipts track separate refund and dispute resources.
- `providerPaymentAllocationCommands` records successful link and unlink commands by their expected revision. The same command can be retried without creating another event or changing a newer allocation.

`paymentRecords` gains two optional fields: `providerPaymentId` and `providerPaidAt`.

## Rules

- **A provider payment is never cash.** Don't read `providerPayments` in a report, a total or an aggregate.
- **One active allocation.** `providerPayments.paymentRecordId` names the one CRM payment that counts for a Whop payment. `paymentRecords.providerPaymentId` is provenance and stays on a row after it stops counting, so two rows may cite the same Whop payment. Read the row that counts through the pointer, and query the `by_tenantId_and_providerPaymentId` index with `take()`, never `.unique()`.
- **Amount and time never tie anything together.** They don't choose the person, the deal or the manual payment. An identifier or a person does.
- **The matcher doesn't use `resolveLeadIdentity`.** This is a deliberate exception to the lead lifecycle ADR's rule 3. Outside bookings that function picks the first match, and it can write. `findPaymentTarget` (`match.ts`) is read-only: it creates nobody and never adds the payer's email to a person.
- **A link adds evidence.** Link and unlink leave cash, payment counts, deal counts and enrollments unchanged. The provider payment's `allocationRevision` starts at zero and advances on each link, unlink or void that clears an allocation. An unlink clears the CRM row's provenance. A side-deal void preserves provenance, releases the allocation and disables membership bindings anchored on that row.
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
- A refund or dispute delivery sets `adverseFencedAt` as soon as its payment is known. A resource read and canonical payment read settle that resource. The fence stays while any resource remains pending. A key missing dispute access still refreshes the payment if the delivery names it.
- Receipts stop retrying when the connection is disconnected or the key is rejected. Sweeps resume from the connection's checkpoints after reconnect and revisit pending resources. Whop's `Retry-After` accepts seconds or an HTTP date and is capped at 15 minutes.
- A re-read never overwrites the resolution (`leadId`, `opportunityId`, `paymentRecordId`, `matchMethod`, or a `reviewState` of `linked`, `recorded` or `dismissed`).
- After storing, `refreshProviderPaymentReview` recomputes where an unresolved payment stands.

`reconcile.ts` covers what webhooks miss:

| Cron | When | What |
| --- | --- | --- |
| `whop-payment-sweep` | every 15 minutes | Payments created, refunded or disputed since the last sweep, plus known non-final facts including drafts. Covers a 30-minute overlap |
| `whop-payment-full-scan` | 07:34 UTC | Every payment, paged across runs. Whop has no `updated_after`, and an old pending payment can turn paid |
| `whop-payment-retention` | 07:54 UTC | Clears raw bodies after 7 days and payer details at their indexed deadlines |

A sweep records unreadable payment IDs and continues with the rest of the page. Provider-wide failures leave a checkpoint at the failing page. A run allows up to 64 pages across Workpool jobs and stops when a cursor repeats. A nightly sweep skips a busy lease.

All requests share a per-connection clock (`connectionState.reserveRequest`) and pin `Api-Version-Date` (`WHOP_API_VERSION_DATE` in `whop/client.ts`). Change the pin on purpose, with the normalizer's tests.

## Where a payment stands

`reviewState` on `providerPayments`:

| State | Meaning |
| --- | --- |
| `not_actionable` | Not paid, or paid zero |
| `needs_person` | Paid, and no CRM payment counts for it yet. `reviewReason` says why |
| `linked` | A person tied it to a payment recorded by hand |
| `recorded` | The CRM payment that counts was created from it (a later phase) |
| `dismissed` | A person said it isn't money for a deal here. `dismissReason` says why |
| `historical` | Collected before the connection's `autoImportAfter` |

`match.ts` decides the reason in this order: an active allocation; a deal binding; else the payer's email must name exactly one surviving person, who must have exactly one open deal, counting every open deal, at Booked or Follow-up. Then the evidence checks: the deal existed when the money was collected, the payment is under 7 days old, it is one mapped line item, it isn't financed or a renewal, the deal has no unlinked manual payment, and there is no refund or dispute. A read that hits its cap counts as ambiguous, never as "none".

`reviewReason: "ready"` means the rule found one person with one open deal. It still needs a person in this phase.

Billing shows the connected environment and badges sandbox facts. Waiting uses a live match for each of its 25 rows and flags rows whose classification was deferred when the read budget ran low. Linked, Dismissed and History are available as filters. Historical payments never appear as suggestions. Refunds and disputes on linked or recorded payments have a separate review list. The table indexes `[tenantId, adverseReviewAt]` and a connection-scoped version for Billing. Seen clears the review item and records an IDs-only Activity event.

**Known limits.** A phone saved only on a person's profile is not seen by the matcher. Phone conflict checks use normalized phone identifiers.

## Permissions

- Connect, rotate, disconnect and map: `settings:manage`.
- See the Billing view: `billing:view`. Link, dismiss and mark a refund or dispute seen: `billing:review`. Unlink and reopen: `billing:correct`. All need Billing Ops enabled.

## Tests

`convex/payments/*.test.ts`, with synthetic fixtures in `tests/whopFixtures.ts` and `tests/providerPaymentFixtures.ts`. No real name, email or id belongs in a fixture.

## Not verified against Whop

The integration was built from Whop's published OpenAPI spec and SDK source. Until a real delivery and a sandbox purchase are observed, these stay open: whose email a payment carries, how each financing provider appears, and the smallest set of scopes that still delivers payment webhooks with the email filled in. `runbooks/whop-measurement.md` describes the read-only measurement that answers the first.
