# Call insights

Claude reads a matched Fathom recording and lists what the prospect said (objections, struggles, goals, income), how the call ended and whether the prospect attended. Code checks every quote against the transcript, Jev checks each item, and the result shows as a "What they said" card on the meeting, a suggested result that prefills the outcome dialogs, and report rows. The plan is `docs/reviews/call-insights-architecture.html`; where this guide and the plan differ, the code follows this guide.

The feature is off until an owner turns it on in Pipeline → Call insights → Settings. `tenants.callInsights` absent means off, and with it off a matched recording costs two reads and nothing else.

## Rules

- Prospect words (quotes, statements, model output) live only on `callInsightRuns`, `resultSuggestionStates` and eval labels. They never go to logs, errors, PostHog, event metadata or `callInsightFacts`. `callInsightFacts` holds categories, numbers and enums only, so reports can read it freely.
- Prospect words live exactly as long as the transcript. `retention.ts` `transcriptGone` is checked at read time, and `maintenance.purgeRecording` blanks every stored copy when Fathom's cleanup deletes the transcript. A new place that stores a quote needs both.
- Every model call reserves its largest possible cost in `budget.ts` before it is sent and settles to the real cost afterwards. A cost that never came back settles at the full reservation. One row per tenant per UTC month, in integer micro-USD. The limit (`monthlyCapUsd`, $60 by default) is shared with Second opinion, whose code this feature never changes.
- A reading is published in one place, `run.publish`, and only if the worker still holds the run's claim, the recording is still matched to the same meeting and the transcript is still there.
- A suggestion never records a result. A person saves through the existing dialogs, which pass `fromSuggestion` so the row is marked used. A closer may skip proof of payment only when saving from a shown, ready payment suggestion.
- A no-show reading is never applied without a person. The one-step "Certain" confirm stays hidden until an admin sets the wait from the wait study and switches it on.
- Opus's judge never passes a quality bar. One admin's committed grades are the truth; the judge can only stop a prompt or model change until someone looks.

## Where things are (`convex/callInsights/`)

| File | What it holds |
| --- | --- |
| `trigger.ts` | The hooks `convex/fathom/recordings.ts` calls when a recording is matched or marked not a sales call, `queueRead`, and what happens when a recording moves to another meeting |
| `run.ts` | The run lifecycle: `load`, `begin` (claim and reserve), `saveExtraction`, `release` (retry or fail), `publish`, and the `read` action |
| `transcriptPrep.ts`, `prompt.ts`, `parse.ts`, `validate.ts`, `income.ts` | What the model is sent, the flat JSON schema it answers in, and the code checks on its answer |
| `itemCheck.ts`, `earlyReading.ts`, `decisions.ts` | Jev: one check per item, two readings of the call, one check of the suggested result |
| `noShow/` | Measurements taken from the transcript and the no-show tier rules |
| `suggest/` | Deriving the suggested result and deciding whether a stored suggestion may be shown or saved from now |
| `publish.ts` | Writing the text-free rows and the suggestion; `reproject` shows a saved reading on the meeting a recording belongs to now |
| `jobs.ts`, `maintenance.ts` | Backfill and eval batches with a spending ceiling; the 15-minute sweep that recovers dead workers; the purge |
| `queries.ts`, `admin.ts`, `reports.ts`, `access.ts` | The public functions. Closers see their own meetings; settings, reports and quality are admin only |
| `eval/` | Quality tests: cases and grades, the bars and their statistics, the Opus judge, planted defects, regression runs, drift, the no-show wait study |
| `settings.ts`, `validators.ts`, `schema.ts` | Settings and defaults, shared validators and version constants, the tables |

Category lists and their version are in `lib/callInsights/taxonomy.ts`. Changing the prompt or its schema means bumping `PROMPT_VERSION` in `validators.ts`; "Read older calls" can then re-read calls read with the old one.

The UI is `components/call-insights/` (the meeting cards and the person section) and `app/workspace/pipeline/call-insights/` (the page and the grading screen). Each card is two files: one holds the query and the mutations (`what-they-said-card.tsx`, `suggestion-card.tsx`, `person-calls-section.tsx`) and one draws it from plain props (`*-view.tsx`), built from the parts in `insight-parts.tsx`. DESIGN.md describes the chip, the quote block and the suggestion panel.

## The Convex AI Gateway

Claude is called at `POST https://ai-gateway.convex.dev/v1/messages` and Jev at `/alpha/decisions`, each with a fresh `getServiceToken("ai-gateway")`. Two limits shaped the schema: the gateway rejects a structured-output schema with more than 16 nullable fields or one whose compiled grammar is too large. So the answer is flat (one `items` list, one list of attendance quotes), every field is required, and "not said" is an empty string, `0` or `"none"`. `parse.ts` turns that back into the shape `validate.ts` works on.

The deployment's AI Gateway usage limit must be unset or above the tenant's monthly limit, or reads fail before the app's own limit is reached.

## Where the build differs from the plan

- Runs are scheduled functions with a 10-minute lease and a claim token, not a Workpool.
- There is no `leads.identityVersion`. Whether a recording is another prospect's call is checked when a run starts and again whenever a reading or suggestion is shown.
- Reports read Convex. Nothing is synced to ClickHouse.
- One admin grades a quality test. There is no second grader and no adjudication.
- A Jev-stage retry repeats the two call readings instead of reusing them, which costs under a tenth of a cent.

## Tests

`tests/callInsightsHarness.ts` builds a tenant with a matched recording and plays the gateway. `convex/callInsights/run.test.ts` covers the lifecycle, the fences and the budget; `saves.test.ts` covers every save that accepts `fromSuggestion`; `synthetic.test.ts` runs made-up calls from `tests/callInsights/synthetic/` through the code checks.
