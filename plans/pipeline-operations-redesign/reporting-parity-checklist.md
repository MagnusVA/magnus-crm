# Reporting Parity Checklist

Use this checklist against the production test tenant before treating the redesigned reports as the default source of truth. Differences are expected when a metric changed from opportunity-led to event-led counting; record the reason instead of forcing the numbers to match.

## Slack Qualifications

- [ ] Ledger qualification event count:
- [ ] Unique linked opportunity count:
- [ ] Unique Slack-sourced opportunity count:
- [ ] Existing opportunity aggregate count:
- [ ] Duplicate/already-booked event count:
- [ ] Unlinked event count:
- [ ] Difference explained:

## Pipeline Health

- [ ] Raw meeting count for selected range:
- [ ] Operations rollup booked-call count:
- [ ] Booked program filter checked:
- [ ] DM team filter checked:
- [ ] DM closer filter checked:
- [ ] Show-rate difference explained:

## Team Performance

- [ ] Phone closer scheduled-call count:
- [ ] Phone closer completed-call count:
- [ ] DM closer attribution count:
- [ ] Revenue total for same date range:
- [ ] Difference explained:

## Revenue

- [ ] Existing revenue total:
- [ ] Redesigned revenue total:
- [ ] Booked-to-sold matrix total:
- [ ] Unknown booked-program bucket reviewed:
- [ ] Unknown sold-program bucket reviewed:
- [ ] Difference explained:

## Cutoffs

- [ ] Attribution backfill cutoff:
- [ ] Slack ledger backfill cutoff:
- [ ] Meeting stats rollup cutoff:
- [ ] Any intentionally excluded historical rows:

## Manual UI Smoke Pass

- [ ] `/workspace/reports/slack-qualifications`
- [ ] `/workspace/reports/pipeline`
- [ ] `/workspace/reports/team`
- [ ] `/workspace/reports/revenue`
- [ ] `/workspace/operations?tab=qualifications`
