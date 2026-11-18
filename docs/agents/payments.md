# Payment providers (Whop)

A tenant can connect its Whop account. Whop's payments then arrive in the CRM as facts in `providerPayments`. A fact is not cash: no report reads these tables, and money counts only through a `paymentRecords` row, as it always has. In this phase a person links a Whop payment to a payment someone already recorded by hand, as evidence. Nothing here creates a payment, wins a deal or changes a number.

Code lives in `convex/payments/`. The screens are Settings › Integrations › Whop (`/workspace/settings/whop`) and Billing › From Whop (`/workspace/billing/whop/[providerPaymentId]`).

## Tables

Defined in `convex/payments/schema.ts`:

- `tenantPaymentConnections`: one Whop account per tenant and environment (`live` or `sandbox`). Holds the API key, the webhook secret, the pinned API version and the sweep state. Only internal functions read the key and secrets; `connection.getConnection` returns a masked view.
- `providerPayments`: one row per Whop payment, as last read. Keyed on tenant, connection and Whop's payment id.
- `paymentProviderBindings`: a Whop product mapped to a program, a Whop variant (price) mapped to a payment type, and later a membership or checkout mapped to a deal. A change inserts a new version and disables the old row.
- `paymentWebhookReceipts`: one row per delivery, kept for good so a redelivery is recognised. The raw body sits in file storage and is deleted after 7 days.

`paymentRecords` gains two optional fields: `providerPaymentId` and `providerPaidAt`.

## Rules

- **A provider payment is never cash.** Don't read `providerPayments` in a report, a total or an aggregate.
- **One active allocation.** `providerPayments.paymentRecordId` names the one CRM payment that counts for a Whop payment. `paymentRecords.providerPaymentId` is provenance and stays on a row after it stops counting, so two rows may cite the same Whop payment. Read the row that counts through the pointer, and query the `by_tenantId_and_providerPaymentId` index with `take()`, never `.unique()`.
- **Amount and time never tie anything together.** They don't choose the person, the deal or the manual payment. An identifier or a person does.
- **The matcher doesn't use `resolveLeadIdentity`.** This is a deliberate exception to the lead lifecycle ADR's rule 3. Outside bookings that function picks the first match, and it can write. `findPaymentTarget` (`match.ts`) is read-only: it creates nobody and never adds the payer's email to a person.
- **A link changes no number.** `review.linkToPaymentRecord` writes the two link fields and the resolution on the provider payment. It must not touch the amount, status, `recordedAt`, credit, aggregates, enrollments or the deal.
- **Times.** `recordedAt` stays the time every report uses. `providerPaidAt` is when Whop collected the money and is shown, never bucketed.
- **Money.** Whop sends `total` as a decimal string with its own `decimals`. `whop/normalize.ts` converts it by exact string arithmetic. `totalMinor` is set only for two-decimal currencies; any other currency goes to a person as `unsupported_currency`. Don't use `toAmountMinor` here: it always multiplies by 100.
- **Personal data.** Stored: the normalized payer email and a phone that arrived with a country code. Not stored: name, address, IP address, browser, card details, Whop's failure text. Email and phone are cleared 90 days after a payment is resolved. Logs, errors and event metadata carry ids and fixed codes only.

## Intake

`POST /webhooks/whop?c=<connectionId>` (`webhook.ts`):

1. The connection id selects the secret and authorizes nothing by itself.
2. `signature.ts` checks the Standard Webhooks signature over the raw body, with a five-minute tolerance. Whop signs with the whole `ws_…` secret as the key. A replaced secret keeps working for 24 hours.
3. The signed `account_id` must equal the connection's.
4. One mutation dedupes on the webhook id, writes the receipt and enqueues the work on `providerPool`, which is separate from the Calendly pool.

Every event means "read this payment again". `intake.ts` reads `GET /payments/{id}` and stores it in `storePaymentRead`:

- A read older than the stored `sourceUpdatedAt`, or whose `refreshGeneration` is no longer the newest, is dropped.
- A refund or dispute delivery sets `adverseFencedAt` at once, before the read. A later read clears it only when the payment's own fields explain it.
- A re-read never overwrites the resolution (`leadId`, `opportunityId`, `paymentRecordId`, `matchMethod`, or a `reviewState` of `linked`, `recorded` or `dismissed`).
- After storing, `refreshProviderPaymentReview` recomputes where an unresolved payment stands.

`reconcile.ts` covers what webhooks miss:

| Cron | When | What |
| --- | --- | --- |
| `whop-payment-sweep` | every 15 minutes | Payments created, refunded or disputed since the last sweep, with a 30-minute overlap |
| `whop-payment-full-scan` | 07:34 UTC | Every payment, paged across runs. Whop has no `updated_after`, and an old pending payment can turn paid |
| `whop-payment-retention` | 07:54 UTC | Deletes raw bodies after 7 days and clears payer details after 90 |

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

## Permissions

- Connect, rotate, disconnect and map: `settings:manage`.
- See the Billing view: `billing:view`. Link and dismiss: `billing:review`. Unlink and reopen: `billing:correct`. All need Billing Ops enabled.

## Tests

`convex/payments/*.test.ts`, with synthetic fixtures in `tests/whopFixtures.ts` and `tests/providerPaymentFixtures.ts`. No real name, email or id belongs in a fixture.

## Not verified against Whop

The integration was built from Whop's published OpenAPI spec and SDK source. Until a real delivery and a sandbox purchase are observed, these stay open: whose email a payment carries, how each financing provider appears, and the smallest set of scopes that still delivers payment webhooks with the email filled in. `runbooks/whop-measurement.md` describes the read-only measurement that answers the first.
