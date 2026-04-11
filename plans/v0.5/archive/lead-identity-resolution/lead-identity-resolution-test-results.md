# Lead Identity Resolution - Test Results

**Feature:** v0.5 Lead Identity Resolution  
**Execution Date:** 2026-04-10 to 2026-04-11  
**Tester:** Codex  
**Method:** Convex CLI backend validation first, then Expect browser verification  
**Calendly booking link used:** `https://calendly.com/d/cvmm-vy4-696/test-meeting-for-crm`  
**Overall Status:** Functional cases passed; non-functional gates had failures

## 1. Environment & Setup

- Tenant verified via Convex CLI: `jh751p7j5mb2r3g1k17a47q6vd842wmj`
- Target event type verified via CLI:
  - `displayName`: `Test meeting for CRM`
  - `eventTypeUri`: `https://api.calendly.com/event_types/1bfc6cdf-0559-4411-8f5d-09d34664b886`
  - `schedulingUrl`: `https://calendly.com/d/cvmm-vy4-696/test-meeting-for-crm`
- Current custom questions confirmed via `testing/calendly:getEventTypeDetailsForTesting`:
  - `Instagram Handle`
  - `Phone Number`
  - `Random question`
- `eventTypeConfigs` pre/post-check confirmed:
  - `socialHandleField = "Instagram Handle"`
  - `socialHandleType = "instagram"`
  - `phoneField = "Phone Number"`
- Existing lead-identity fixture records were removed before rerun so the exact fixture emails from the plan could be reused cleanly.
- The default helper slot lookup was not used for this rerun. I used `testing/calendly:listAvailableSlots` with an explicit future window, then booked every case with explicit `startTimeIso` values, which matches the fallback path in the test plan.

## 2. Tracking Worksheet

| Alias | Booking purpose | eventUri | meetingId | opportunityId | leadId | assignedCloserEmail |
| --- | --- | --- | --- | --- | --- | --- |
| `E1` | email case first booking | `https://api.calendly.com/scheduled_events/bea17567-9298-4145-8209-f072d0495545` | `k57c9dgqya12te4qt90z897tcd84m2na` | `k97etvwn1jf8tzva7aq2hdqsjs84nt6w` | `k179nmpsxrkykjdczs682qhtjh84mbzb` | `vas.claudio15+closer2@icloud.com` |
| `E2` | email case second booking | `https://api.calendly.com/scheduled_events/c8122a07-dd3c-4d9c-9795-2c1662818c60` | `k5759zm7vcpxhec1sc10gccqfx84n408` | `k970tck0hhvjbnfa20yeyhq43x84n366` | `k179nmpsxrkykjdczs682qhtjh84mbzb` | `vas.claudio15+closer1@icloud.com` |
| `S1` | social case first booking | `https://api.calendly.com/scheduled_events/c92c761e-2fde-483d-877b-381f3b2f1a17` | `k5716ak3y3jmpjqhedzwn9ehy584n7w9` | `k978a223g8nsweb2tqdq7et8hn84ntsq` | `k171a8tk48d6fh6he5mst7mfys84mqer` | `vas.claudio15+closer1@icloud.com` |
| `S2` | social case second booking | `https://api.calendly.com/scheduled_events/eff9462f-d7f3-4500-92be-fe1e8590f4db` | `k575f5yc35j9n54nhawf8xp4ch84mkvx` | `k97cgjrn4hrfb7vygvxjadyx9184mmm0` | `k171a8tk48d6fh6he5mst7mfys84mqer` | `vas.claudio15+closer2@icloud.com` |
| `P1` | phone case first booking | `https://api.calendly.com/scheduled_events/45d94de5-4d3f-4ad7-adb9-610a437cff54` | `k576x7kmg8q47qrjeehx8yft1x84mme6` | `k97bmm4q8w0p2asbbtr5nnn68x84mkfr` | `k172b1hkkgja1cndrpb568wy2184n76c` | `vas.claudio15+closer2@icloud.com` |
| `P2` | phone case second booking | `https://api.calendly.com/scheduled_events/284ca874-bb4c-4e80-a120-46628eebbc08` | `k57drgd0ead1xhdep2mzzymzj984mqkj` | `k972m2sma16989y25tt5xr7bbd84mtga` | `k172b1hkkgja1cndrpb568wy2184n76c` | `vas.claudio15+closer2@icloud.com` |
| `D1` | duplicate positive first booking | `https://api.calendly.com/scheduled_events/6b98316d-2664-4cce-81d5-873d9e6557e4` | `k57527kz03fxmh2hg1vd5dx64184m0n2` | `k975pvmh68m3ab31g1f8pr61v584mprh` | `k17cy50fr0sgr53j203sp05m3d84my4w` | `vas.claudio15+closer2@icloud.com` |
| `D2` | duplicate positive second booking | `https://api.calendly.com/scheduled_events/3539bc4f-586b-4a56-bcff-f323efc75286` | `k57a75z2c9xagtsjyyzpx9ap8d84m87r` | `k97a1qzq0p3wt4w87bykawpxs584mw3b` | `k17e57m9ce84d7p86n2y5yey3x84myhe` | `vas.claudio15+closer1@icloud.com` |
| `N1` | duplicate negative first booking | `https://api.calendly.com/scheduled_events/29cfc143-5246-4edc-9488-3e11f8d65038` | `k576n8cbphq0212b4cpz7yjvtx84ny3x` | `k97eq13n20bcxr22ncq8mtp48584mkhx` | `k176115rsyh3sv196pfnq9ekns84mcwy` | `vas.claudio15+closer1@icloud.com` |
| `N2` | duplicate negative second booking | `https://api.calendly.com/scheduled_events/cef3e8ef-7d14-4515-969c-9f8d319b783a` | `k57a6p2zb3wdtg8ahtytxxck4x84nyrr` | `k973pgh0jez6kcyewm6fycxarh84nty1` | `k176f2b86dgkf2fr43x4nazphx84ne7f` | `vas.claudio15+closer2@icloud.com` |

## 3. Case Results

### TC-A: Field Mappings UI

**TC-A1 — Pass**

- CLI pre-check confirmed `Test meeting for CRM` with `knownCustomFieldKeys = ["Instagram Handle", "Phone Number", "Random question"]`.
- Expect verification as tenant owner confirmed:
  - Settings page loaded.
  - `Field Mappings` tab loaded.
  - `Test meeting for CRM` card rendered.
  - Card showed booking count, field count, and badges.
  - `Configure Field Mappings` dialog opened.
  - Dialog description referenced `Test meeting for CRM`.
  - Dropdowns exposed `Instagram Handle`, `Phone Number`, and `Random question`.

**TC-A2 — Pass**

- Expect inline validation matched the test plan exactly:
  - `Select a platform when a social handle field is mapped.`
  - `Cannot use the same field for both social handle and phone.`

**TC-A3 — Pass**

- Expect saved:
  - `Social Handle Field -> Instagram Handle`
  - `Social Platform -> Instagram`
  - `Phone Field (Override) -> Phone Number`
- Expect verified toast: `Field mappings saved`
- Expect verified card badges: `Instagram mapped`, `Phone mapped`
- Refresh + reopen confirmed persistence.
- CLI post-check confirmed:
  - `customFieldMappings.socialHandleField = "Instagram Handle"`
  - `customFieldMappings.socialHandleType = "instagram"`
  - `customFieldMappings.phoneField = "Phone Number"`

**TC-A4 — Pass**

- Expect verification as `vas.claudio15+closer1@icloud.com`:
  - opening `/workspace/settings` redirected to `http://localhost:3000/workspace/closer`
  - closer navigation did not expose the `Field Mappings` tab

### TC-B: Exact Email Match

**Status: Pass**

**CLI evidence**

- `E1.leadId === E2.leadId === k179nmpsxrkykjdczs682qhtjh84mbzb`
- exactly one `leadIdentifiers` row exists for `type=email`, `value=vas.claudio15+eir-email-01@icloud.com`
- both opportunities exist and both meetings exist
- neither opportunity has `potentialDuplicateLeadId`
- logs show:
  - `Email match via legacy index`
  - `Resolution complete | ... via=email potentialDuplicate=none`

**Expect evidence**

- As assigned closer for `E2`, meeting page [k5759zm7vcpxhec1sc10gccqfx84n408](/Users/nimbus/dev/ptdom-crm/plans/v0.5/lead-identity-resolution/lead-identity-resolution-test-results.md) showed:
  - lead email `vas.claudio15+eir-email-01@icloud.com`
  - `Meeting History` with two entries
  - current meeting marked `Current`
  - no duplicate banner
  - `Booking Answers` included `Random question = EIR_EMAIL_2`

### TC-C: Exact Social Handle Match

**Status: Pass**

**CLI evidence**

- `S1.leadId === S2.leadId === k171a8tk48d6fh6he5mst7mfys84mqer`
- surviving lead primary email remained `vas.claudio15+eir-social-01@icloud.com`
- no lead exists with primary email `vas.claudio15+eir-social-02@icloud.com`
- identifiers on the reused lead include:
  - `instagram / eir_social_match / inferred`
  - `email / vas.claudio15+eir-social-01@icloud.com / verified`
  - `email / vas.claudio15+eir-social-02@icloud.com / verified`
- lead `socialHandles` includes `instagram / eir_social_match`
- neither opportunity has `potentialDuplicateLeadId`
- logs show:
  - `Social handle match | ... handle=eir_social_match`
  - `Resolution complete | ... via=social_handle potentialDuplicate=none`

**Expect evidence**

- As assigned closer for `S2`, meeting page showed:
  - lead email `vas.claudio15+eir-social-01@icloud.com`
  - two-entry `Meeting History`
  - no duplicate banner
  - `Booking Answers` included `Instagram Handle = https://www.instagram.com/eir_social_match/`

### TC-D: Exact Phone Match Via Custom Field Override

**Status: Pass**

**CLI evidence**

- `P1.leadId === P2.leadId === k172b1hkkgja1cndrpb568wy2184n76c`
- primary lead email remained `vas.claudio15+eir-phone-01@icloud.com`
- the reused lead has exactly one phone identifier:
  - `type=phone`
  - `value=+15005550121`
  - `confidence=verified`
- reused lead also has both email identifiers
- neither opportunity has `potentialDuplicateLeadId`
- logs show:
  - `Phone override extracted from custom field | field="Phone Number" rawValue="(500) 555-0121"`
  - `Phone override extracted from custom field | field="Phone Number" rawValue="+1 500 555 0121"`
  - `Phone match | ... phone=+15005550121`
  - `Resolution complete | ... via=phone potentialDuplicate=none`

**Expect evidence**

- As assigned closer for `P2`, meeting page showed:
  - lead phone `+1 500 555 0121`
  - two-entry `Meeting History`
  - no duplicate banner
  - `Booking Answers` included `Phone Number = +1 500 555 0121`

### TC-E: Potential Duplicate Positive

**Status: Pass**

**CLI evidence**

- `D1.leadId = k17cy50fr0sgr53j203sp05m3d84my4w`
- `D2.leadId = k17e57m9ce84d7p86n2y5yey3x84myhe`
- `D2.opportunity.potentialDuplicateLeadId = k17cy50fr0sgr53j203sp05m3d84my4w`
- `D1.opportunity.potentialDuplicateLeadId = null`
- identifiers for this case remained email-only
- logs show:
  - `Potential duplicate detected | newLeadId=k17e57m9ce84d7p86n2y5yey3x84myhe candidateLeadId=k17cy50fr0sgr53j203sp05m3d84my4w domain=identity-qa.example.com`

**Expect evidence**

- As assigned closer for `D2`, meeting page showed the amber duplicate banner text:
  - current lead name `Marina Cole Jr`
  - suspected duplicate `Marina Cole`
  - duplicate lead email `eir-dup-01@identity-qa.example.com`
- the banner was informational only; no merge or dismiss action was present

### TC-F: Potential Duplicate Negative For Public Domains

**Status: Pass**

**CLI evidence**

- `N1.leadId != N2.leadId`
- `N2.opportunity.potentialDuplicateLeadId = null`
- identifiers for this case remained email-only

**Expect evidence**

- As assigned closer for `N2`, meeting page loaded normally
- no `Potential Duplicate Lead` banner appeared

### TC-G: Cross-Case Regression Checks

**TC-G1 — Pass**

- `email` identifiers are `confidence="verified"`
- `phone` identifiers are `confidence="verified"`
- `instagram` identifiers are `confidence="inferred"`
- duplicate count for `(tenantId, type, value)` pairs: `0`

**TC-G2 — Pass**

- reused social-match lead has `socialHandles = [{ type: "instagram", handle: "eir_social_match" }]`
- email-match lead did not gain unrelated social handles
- phone-match lead did not gain unrelated social handles

**TC-G3 — Pass**

- no uncaught pipeline errors were found for the executed cases
- no unexpected identifier-conflict warnings were observed
- successful field-mapping save path did not surface backend save failures

### TC-H: Non-Functional Expect Gates

**TC-H1 Responsive checks — Pass with one gap**

- Owner `Field Mappings` tab:
  - tested at `375x812`, `768x1024`, `1280x800`, `1440x900`
  - no horizontal overflow detected
- `D2` duplicate-banner meeting detail page:
  - tested at the same four viewports
  - no horizontal overflow detected
  - duplicate banner text remained readable at mobile width
  - meeting detail content remained readable
- Gap:
  - I verified the Field Mappings page itself at all four breakpoints, but I did not separately reopen the mapping dialog during the responsive pass to prove every dialog control remained usable on mobile.

**TC-H2 Console and network checks — Fail**

- Owner Field Mappings page console errors:
  - `The Content Security Policy directive 'upgrade-insecure-requests' is ignored when delivered in a report-only policy.` (2 occurrences)
- `D2` meeting page console errors:
  - same CSP report-only console error (2 occurrences)
- No 4xx/5xx request failures were detected on the tested flows.
- Network captured duplicate requests, but no failed requests.

**TC-H3 Accessibility audit — Fail**

- Owner Field Mappings page audit: `12 serious` violations
- `D2` duplicate-banner meeting page audit: `13 serious` violations
- Concrete app-facing findings included:
  - unlabeled visible controls flagged by `input_label_visible`
  - invalid breadcrumb separator `role="presentation"` usage on focusable `<li>` nodes
  - invalid `aria-controls` / `aria_id_unique` issues on Radix controls
  - tablist keyboard/focus issues on Settings tabs
  - placeholder-only visible labeling on the meeting notes textarea
- Note:
  - the accessibility tool also reported some overlay-related issues from the Expect audit overlay itself (`svg_graphics_labelled`, `text_block_heading`), but there were enough app-level serious issues to fail this gate regardless.

**TC-H4 Performance metrics — Pass**

- Owner Field Mappings page:
  - `FCP 692ms (good)`
  - `LCP 884ms (good)`
  - `CLS 0 (good)`
  - `INP 200ms (needs-improvement, not poor)`
  - `TTFB 56ms`
  - worst LoAF blocking duration `0ms`
- `D2` duplicate-banner meeting detail page:
  - `FCP 392ms (good)`
  - `LCP 808ms (good)`
  - `CLS 0 (good)`
  - `TTFB 85ms`
  - worst LoAF blocking duration `0ms`
- No Web Vital was rated `poor`, and no LoAF exceeded the `150ms` fail threshold.

## 4. Expected vs Observed Mismatches

### Mismatch 1: TC-H console gate failed

- **Expected:** no console errors
- **Observed:** both audited routes emitted the CSP report-only console error:
  - `The Content Security Policy directive 'upgrade-insecure-requests' is ignored when delivered in a report-only policy.`

### Mismatch 2: TC-H accessibility gate failed

- **Expected:** no critical or serious violations
- **Observed:** both audited routes produced serious violations in Expect accessibility audits.
- Example concrete findings:
  - unlabeled visible button controls
  - invalid breadcrumb separator roles
  - invalid `aria-controls` references
  - placeholder-only labeling on meeting notes

### Mismatch 3: TC-H responsive dialog-control proof is incomplete

- **Expected:** explicit responsive verification that the Field Mappings dialog controls remain usable on mobile
- **Observed:** responsive verification covered the Field Mappings page and the duplicate-banner meeting page at all required widths, but I did not reopen the dialog during the responsive sweep itself.

## 5. Final Status Matrix

| Case | Status |
| --- | --- |
| TC-A1 | Pass |
| TC-A2 | Pass |
| TC-A3 | Pass |
| TC-A4 | Pass |
| TC-B | Pass |
| TC-C | Pass |
| TC-D | Pass |
| TC-E | Pass |
| TC-F | Pass |
| TC-G1 | Pass |
| TC-G2 | Pass |
| TC-G3 | Pass |
| TC-H1 | Pass |
| TC-H2 | Fail |
| TC-H3 | Fail |
| TC-H4 | Pass |

## 6. Completion Checklist

- [x] Tenant and event type verified through the CLI
- [x] Field mappings configured to `Instagram Handle -> instagram` and `Phone Number -> phone override`
- [x] Same-email pair reuses one lead and shows two meetings in UI
- [x] Same-Instagram pair reuses one lead and stores the second email only in `leadIdentifiers`
- [x] Same-phone pair reuses one lead through the mapped custom phone field
- [x] Non-public-domain duplicate pair creates two leads and flags the second opportunity
- [x] Public-domain duplicate pair creates two leads and does not flag the second opportunity
- [x] `leadIdentifiers` confidence values are correct and unique
- [x] `socialHandles` denormalization is correct
- [x] Settings UI authorization is enforced for closers
- [ ] Responsive, console/network, accessibility, and performance checks all pass in Expect

## 7. Verdict

The rerun hit the original expected functional outcomes now that `Instagram Handle` is optional. The core lead-identity-resolution behavior for email-only, social-handle, phone-override, duplicate-positive, and public-domain duplicate-negative cases all matched the test plan across Convex data, logs, and Expect meeting-detail verification.

The suite does not fully pass because the non-functional gates failed on console cleanliness and accessibility. The results above are complete enough for review, and the remaining follow-up should focus on TC-H2 and TC-H3 rather than the lead identity logic itself.
