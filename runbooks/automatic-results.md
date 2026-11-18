# Check an automatic result

Find the decision by payment or meeting ID, or start with a decision ID from the audit queue. Check the tenant, kind, and time before comparing rows. A new reading or Whop refresh can leave several decisions for the same meeting or payment.

The commands below target your personal Convex dev deployment. Use a synthetic tenant and replace the example identity and IDs with values from that tenant. The named queries require the appropriate owner or admin role. The inline queries are read-only. Run them from the checkout.

## Read the decision

```sh
npx convex data resultAutomationDecisions --limit 10 --deployment dev
npx convex run --deployment dev --inline-query '
  const id = ctx.db.normalizeId("resultAutomationDecisions", "DEV_DECISION_ID");
  return id ? await ctx.db.get("resultAutomationDecisions", id) : null;
'
```

| Field | What to check |
| --- | --- |
| `state` | `shadow` is for grading. `ready` is eligible for confirmation or execution. `notice` is a refusal waiting for acknowledgment or its deadline. `needs_person` and `blocked` need review. `applied` is the receipt. `stopped` and `superseded` retire a decision. `undone` and `corrected` are receipts a person acted on. Follow `supersededByDecisionId` when present. |
| `mode` | `shadow` stores a decision, `ask` offers one tap, and `automatic` can write when due. This field describes the row. Compare it with the kind's current effective level. Off produces no new decision. |
| `gates` | Fixed codes for the facts that made the rule abstain or require a person, such as `ambiguous_person`, `out_of_scope`, or `stood_down`. Read them with `wouldWrite`. A ready automatic decision can still wait on its deadline or a fresh Whop sweep. |
| `stopCode` | The reason a decision was retired. Check human actions (`human_result`, `person_stop`), policy (`paused`, `kind_lowered`, `breaker`, `certificate_lapsed`), changed evidence (`adverse`, `input_changed`, `merged`, `recording_moved`, `transcript_gone`), or a refusal check (`deal_closed`, `payment_found`, `closer_changed`, `late_wakeup`, `newer_meeting`). |
| `dueAt` and receipt fields | `dueAt` is the next execution time. For an applied result, check `resolvedAt`, `appliedVia`, `resolvedByUserId`, and the payment or task ID. Automatic receipts name the certificate in `certificateSampleId`. |

The decision stores references to call evidence. The quote text lives on the reading and follows transcript retention.

## A kind went back to one tap

Compare the configured level with the effective level in `getSettings`. Check `automatic[kind]` for the certificate and blocked reason. A serving rule version change makes an automatic kind read as ask before the sweep stamps a breaker. Check whether the tenant paused automation or lowered the kind, and whether Call insights is on for call kinds.

```sh
npx convex run automation/settings:getSettings '{}' --deployment dev \
  --identity '{"subject":"user_dev_owner","org_id":"org_dev_example"}'
npx convex run automation/audit:listAuditQueue '{"kind":"payment_win"}' --deployment dev \
  --identity '{"subject":"user_dev_owner","org_id":"org_dev_example"}'
npx convex data automationSamples --limit 10 --deployment dev
```

| Breaker reason | Where it is set | What to check |
| --- | --- | --- |
| `wrong_write` | `audit.recordAudit` | A grader marked person, deal, false loss, or should abstain wrong. Open the receipt named by the breaker and read `auditWrongFields`. |
| `audit_overdue` | `audit.tripOverdueAudit` in the automation sweep, or `audit.recordAudit` when a non-severe verdict arrives at or after the deadline | Check `auditOpenDueAt` on the receipt. The first ten writes of each kind are canaries with one business day to grade. Later sampled writes get seven days. |
| `not_my_sale_unanswered` | `breaker.checkTenantBreakers` in the automation sweep | A payment's `notMySaleAt` passed one business day without an answer. Check the payment kinds and the flag in Billing. |
| `certificate_lapsed` | `breaker.checkTenantBreakers` in the automation sweep | The promoted rule version differs from the serving version. For a call kind, compare the rule, prompt, model, thresholds, and checks. |

An audit for amount, type, or program holds the relevant product or variant mapping via `breaker.holdMapping`. Check `automaticHeldAt` and `automaticHeldDecisionId` if only payments using one mapping dropped to ask. A stale Whop sweep can delay writes without tripping a breaker.

## A refusal notice did not close

Read the notice row and its acknowledgment. If the row has a successor, inspect the successor's round and deadline. Once a person acknowledges a notice, the default wait is 48 hours. Use the saved `noticeHours` on the row for that round.

```sh
npx convex data closerPinnedLines --limit 10 --deployment dev
npx convex run automation/notice:listNotices '{}' --deployment dev \
  --identity '{"subject":"user_dev_owner","org_id":"org_dev_example"}'
npx convex run --deployment dev --inline-query '
  const jobs = await ctx.db.system.query("_scheduled_functions").order("desc").take(100);
  return jobs.filter(j => j.name === "automation/notice:finalizeRefusal")
    .map(j => ({ state: j.state.kind, scheduledTime: j.scheduledTime, decisionId: j.args[0]?.decisionId }));
'
```

Check the 15 conditions in `notice.finalizeRefusal` in order.

1. [ ] The row is a `refusal_loss` in `notice`. There is a valid acknowledgment, and a closer acknowledgment comes from the notice's assignee. `noticeHours` is finite and at least 24. `dueAt` equals `acknowledgedAt + noticeHours × 3,600,000` and has arrived. Without these, the executor does nothing.
2. [ ] The wake-up is at most 24 hours past `dueAt`. A later wake-up retires the round with `late_wakeup` and can start a fresh unacknowledged round.
3. [ ] The tenant is active and automation is enabled. A pause withdraws with `paused`.
4. [ ] Refusal is effectively automatic, the decision is automatic and would write, and its certificate passes. A failed certificate or lowered kind can withdraw to an ask. Check `certificate_lapsed` or `kind_lowered`, and look for a breaker in settings.
5. [ ] The decision still matches the tenant activation version and refusal policy version. A mismatch withdraws with `kind_lowered`.
6. [ ] The same recording is matched to the same meeting and person. The serving run is answered, its generation and IDs match the evidence, and the active call header still points to it. A mismatch withdraws with `recording_moved`.
7. [ ] The transcript is still readable and neither the run nor the call header has purged quotes. Otherwise expect `transcript_gone`.
8. [ ] The deal is open at the saved Booked or Follow-up position. The meeting is still scheduled with the same slot and deal. Otherwise expect `deal_closed`.
9. [ ] The deal's human result revision is unchanged and there is no open task. A new result or task withdraws with `human_result`.
10. [ ] The refusal's veto history is within the read limit and has no active veto. Otherwise expect `person_stop`.
11. [ ] The deal is still assigned to the notice's closer. Reassignment withdraws with `closer_changed` and can start a round for the new closer.
12. [ ] The person's deal history is within the read limit and there is no newer scheduled, held, or no-show meeting across those deals. Otherwise expect `newer_meeting`.
13. [ ] There is no recorded or verified CRM payment on any of the person's deals and no qualifying Whop fact for the person. The fact check considers resolved and candidate people, the import cutoff, and paid, unresolved, pending, or authorized payments. Overflow also stands down the notice with `payment_found`.
14. [ ] Each Whop connection that is still in use has a successful sweep within 15 minutes. A stale connection keeps the notice open. The executor requests a sweep for connected accounts and the scheduled path retries in 10 minutes. The recurring deadline sweep can pick it up too.
15. [ ] The live call rule still produces the same decision and would write. Otherwise expect `input_changed`. A successful write closes the deal with `call_refusal` and marks the meeting held.

## An automatic payment did not record

Check the decision and Whop fact together. Use the decision's `providerPaymentId` and `opportunityId` in the Billing preview. The preview uses current facts. Compare its result with the decision's stored gates and receipt.

```sh
npx convex data paymentRecords --limit 10 --deployment dev
npx convex run payments/confirm:previewWhopConfirm \
  '{"providerPaymentId":"DEV_PROVIDER_PAYMENT_ID","opportunityId":"DEV_DEAL_ID"}' \
  --deployment dev --identity '{"subject":"user_dev_owner","org_id":"org_dev_example"}'
npx convex run automation/scorecard:getAutomationScorecard '{"windowDays":7}' --deployment dev \
  --identity '{"subject":"user_dev_owner","org_id":"org_dev_example"}'
npx convex run --deployment dev --inline-query '
  const id = ctx.db.normalizeId("providerPayments", "DEV_PROVIDER_PAYMENT_ID");
  const payment = id && await ctx.db.get("providerPayments", id);
  if (!payment) return null;
  const { status, reviewState, reviewReason, paymentRecordId, allocationRevision,
    sourceUpdatedAt, adverseState, adverseFencedAt, notMySaleAt } = payment;
  return { status, reviewState, reviewReason, paymentRecordId, allocationRevision,
    sourceUpdatedAt, adverseState, adverseFencedAt, notMySaleAt };
'
```

Check the executor in `convex/automation/automaticPayments.ts` in this order.

1. Confirm the row is a ready automatic `payment_win` or `additional_payment` with both the payment and deal IDs, and that `dueAt` has arrived. A first win waits 15 minutes from decision creation. An eligible later payment through a confirmed membership binding is due at once.
2. Check `assertAutomaticAllowed`. The kind must be automatic on the current certificate with no breaker or unresolved overdue "This isn't my sale" flag. The policy and activation versions must match. The product and variant mappings must be enabled, current, in scope, and free of holds. The payment's Whop connection needs a successful sweep within 60 minutes. A stale sweep moves `dueAt` 10 minutes forward. Other failures drop to ask, or stop the row if the kind is off. Mapping failures add `out_of_scope` or `mapping_held`.
3. Check whether a fresh derivation still matches `inputKey`. A new source read, changed allocation, adverse status, or changed deal or binding can invalidate it. The executor supersedes the old row with `input_changed` and requests evaluation.
4. Check that the deal is still in the same tenant and its `humanResultRevision` matches the decision. A mismatch supersedes the row and requests evaluation.
5. Compare the Billing preview with the intended kind and check for an existing allocation. The executor previews and applies in the same mutation. Apply rechecks the fingerprint, allocation revision, evidence, and proposal. A refusal here supersedes the decision and requests evaluation. On success, the Whop fact's `paymentRecordId` points to the counting CRM payment, which has `origin: "provider"` and an automatic decision receipt. A scheduled meeting on a Whop-won deal still owes attendance.

To inspect the job without running the executor, read its scheduler entry.

```sh
npx convex run --deployment dev --inline-query '
  const jobs = await ctx.db.system.query("_scheduled_functions").order("desc").take(100);
  return jobs.filter(j => j.name === "automation/automaticPayments:executeAutomaticPayment")
    .map(j => ({ state: j.state.kind, scheduledTime: j.scheduledTime, decisionId: j.args[0]?.decisionId }));
'
```
