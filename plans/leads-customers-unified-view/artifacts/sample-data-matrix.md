# Leads & Customers Unified View - Sample Data Matrix

**Phase:** 0B - Sample Data and Edge Case Matrix  
**Date captured:** 2026-05-31  
**Deployment inspected:** Production test tenant via read-only `npx convex data --prod` commands and `npx convex insights --details`.

## Redaction Rule

Do not paste names, emails, phone numbers, social handles, raw search terms, notes, payment references, Slack user labels, or screenshots containing those values into this plan. Store only Convex IDs, lifecycle/status labels, role context, counts, and expected behavior.

## Evidence Commands

- `npx convex data leads --prod --limit 100 --format json`
- `npx convex data customers --prod --limit 100 --format json`
- `npx convex data opportunities --prod --limit 100 --format jsonl`
- `npx convex data meetings --prod --limit 50 --format jsonl`
- `npx convex data meetingComments --prod --limit 200 --format jsonl`
- `npx convex data paymentRecords --prod --limit 100 --format jsonl`
- `npx convex data leadMergeHistory --prod --limit 100 --format jsonl`
- `npx convex data slackQualificationEvents --prod --limit 100 --format jsonl`
- `npx convex data leadIdentifiers --prod --limit 80 --format json`

All command output was filtered to omit raw PII before documenting IDs here. Production inspection was read-only. Larger complete `opportunities` and `meetings` dumps hit Convex CLI JSON stream parse/truncation failures, so broad absence claims below are sampled unless a targeted helper or fixture confirms them.

## Matrix

| Scenario | Lead ID | Customer ID | Opportunity ID | Meeting ID | Viewer role | Fixture state | Expected behavior |
|---|---|---|---|---|---|---|---|
| Active lead by social handle / identifier | `jh7b3sydtecaebnxgwhkgt89vx87rgt1` | N/A | `js77qmj008amyyrd1zhyh801a587sxt6` | `jn7f4x0eh4ddnhj9hah0gjrc1987rh7z` | `tenant_master`, `tenant_admin`, assigned `closer` | Present; lead has email, phone, and 1 social handle; opportunity source `slack_qualified`, status `scheduled`, assigned closer present. | Search projection returns a lead lifecycle row; detail shows identifiers, one opportunity, one meeting, and no customer strip. |
| Converted customer by email / lead ID | `jh7crvrqnyaja42vhg3zzqx3cs868dga` | `kn72qkawryzvrm7rjg6r0tdhm587mvxq` | `js710qs5vknphw0phkz2hpf1fd87jqdc` | `jn7107dzq0d7gkzpmx6stweqzs87kzq6` | `tenant_master`, `tenant_admin`, assigned `closer` | Present; customer status `active`; payment `jx7bcn43a59w0aj47a357knxf187m93k`; total paid minor units `10000`, payment count `1`. | Search projection returns customer lifecycle; detail shows customer strip, payment total, winning opportunity, meeting, attribution, and payment row. |
| Slack-qualified opportunity | `jh7a32mczj0s678rd6c0hy1qsx87scb4` | N/A | `js72m8ek0ns3zfb7ffb1arn51587r7g7` | N/A | `tenant_master`, `tenant_admin`, `closer` | Present; opportunity source `slack_qualified`, status `qualified_pending`, unassigned; Slack event `ps7bwrw1phkbpetnm1kkgnw35n87r7br`. | Search returns lead lifecycle with Slack signal; detail attribution shows Slack qualification without exposing raw Slack labels in logs. |
| Lead with comments inline | `jh7crvrqnyaja42vhg3zzqx3cs868dga` | `kn72qkawryzvrm7rjg6r0tdhm587mvxq` | `js710qs5vknphw0phkz2hpf1fd87jqdc` | `jn7107dzq0d7gkzpmx6stweqzs87kzq6` | Assigned `closer`, admin roles | Present; meeting has active comment `mn78t2fxb39w1pzgdb0cq5f61987n04t`. | Entity detail shows bounded comments for authorized viewers; unassigned closers do not receive comments. |
| Opportunity ID direct lookup | `jh7crvrqnyaja42vhg3zzqx3cs868dga` | `kn72qkawryzvrm7rjg6r0tdhm587mvxq` | `js710qs5vknphw0phkz2hpf1fd87jqdc` | `jn7107dzq0d7gkzpmx6stweqzs87kzq6` | `tenant_master`, `tenant_admin`, assigned `closer` | Present through customer/payment linkage. | Search/direct resolver maps opportunity ID to `/workspace/leads-customers/[leadId]?opportunityId=[opportunityId]`; sheet loads through existing opportunity guard. |
| Meeting ID direct lookup | `jh7crvrqnyaja42vhg3zzqx3cs868dga` | `kn72qkawryzvrm7rjg6r0tdhm587mvxq` | `js710qs5vknphw0phkz2hpf1fd87jqdc` | `jn7107dzq0d7gkzpmx6stweqzs87kzq6` | `tenant_master`, `tenant_admin`, assigned `closer` | Present through customer/payment linkage. | Search/direct resolver maps meeting ID to the parent entity; meeting row opens the correct admin or closer meeting route in a new tab. |
| Side-deal opportunity | TBD | N/A/TBD | TBD | N/A | `tenant_master`, `tenant_admin`, `closer` | Missing in sampled production data: no `opportunities.source == "side_deal"` rows found in the first 100 opportunity rows inspected; complete large scan needs a targeted helper because raw CLI JSON stream parsing failed on larger dumps. | Create before Phase 5 using the existing `/workspace/opportunities/new` flow or CLI-backed manual QA, then verify side-deal creation redirects and sheet payment/lost/delete actions. |
| Lead with multiple meetings | `jh7a0030eqsmpj0zc2z8q9dxt587q8vt` | N/A | `js75a1hjaqn50vahmtbdf24xrx87q26m` | `jn794vg3xwcks4xapvtvh9jjfd87p264`, `jn71jb1g6qmvqp93rqskzvn48s87qhsh` | `tenant_master`, `tenant_admin`, assigned `closer` | Present; opportunity source `slack_qualified`, status `canceled`; sampled meetings include `follow_up` and `new` classifications. | Detail should show a bounded, chronologically sorted meeting section across multiple meetings. |
| Merged lead legacy route | Source TBD; target TBD | N/A | TBD | N/A | `tenant_master`, `tenant_admin`, `closer` | Missing in production inspection: `leadMergeHistory` has no documents; no merged lead fixture identified from sampled leads. | Create through existing merge route before Phase 4 redirect QA; old source lead URL should redirect to target entity route without tenant-leak errors. |
| Unassigned opportunity for closer | `jh7a32mczj0s678rd6c0hy1qsx87scb4` | N/A | `js72m8ek0ns3zfb7ffb1arn51587r7g7` | N/A | `closer` | Present; source `slack_qualified`, `assignedCloserId == null`. | Person lookup can show summary context if MVP preserves broad lead lookup, but no opportunity sheet/comments/payment actions should be available unless backend guard permits them. |

## Fixture Gaps

The production test tenant does not yet satisfy every Phase 0 acceptance scenario. Before Phase 5 rollout QA, create and record redacted IDs for:

| Gap | Required fixture | Safe creation path |
|---|---|---|
| Side deal | One active lead with one `source: "side_deal"` opportunity | Existing side-deal UI/mutation after route remains available, or a controlled authenticated QA session. |
| Merged lead | One merged source lead and one active target lead with merge history | Existing `/workspace/leads/[leadId]/merge` UI using test records. |

Phase 1 backend implementation can start with these gaps documented because projection/query contracts do not require these fixtures to exist yet. Phase 4/5 redirect and rollout QA cannot pass until they are filled.

## Data Inspection Notes

- Production customer fixtures have payment records tied to opportunity and meeting IDs, but `paymentRecords.leadId` is `null`; entity detail must derive lead context through the customer/opportunity path when needed.
- Production `meetings` sample rows have `leadId: null`; direct meeting lookup should resolve via `meeting.opportunityId -> opportunity.leadId`.
- Production comments are keyed by `meetingId`; comment rows do not store `opportunityId`.
- Production Slack-qualified fixtures include `slack_qualified` opportunity sources and matching `slackQualificationEvents`.
