---
target: person-detail
total_score: 22
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 4
target_identity: "file:/Users/nimbus/.t3/worktrees/ptdom-crm/t3-fac7d69c/app/workspace/leads-customers/[leadId]/page.tsx"
target_fingerprint: "sha256:0ae115f81cbe3b45fe964021f375a88bb5a172f60205cf5ec2e5fc5f69a39848"
target_path: /Users/nimbus/.t3/worktrees/ptdom-crm/t3-fac7d69c/app/workspace/leads-customers/[leadId]/page.tsx
timestamp: 2026-10-29T04-49-57Z
slug: app-workspace-leads-customers-leadid-page-tsx
---
# Assessment A: Person detail and deal sheet

## 1. Design specificity
**The composition is generic; the data is specific to this product.** The content uses the domain model (lifecycle, disposition, touches, attribution), but it sits in 11 equally weighted shadcn cards that would suit any CRM. The page never shows how a person's deals hold their meetings and payments.

## 2. Nielsen
| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Status | 3 | Skeletons and toasts work; opening a deal sheet doesn't update the URL |
| 2 | Real world | 2 | Says "Opportunities", not deal; shows "Lead · active"; copy reads "opp / mtg" and "may exist in Convex" |
| 3 | Control | 2 | Back doesn't close the sheet; deleting a deal lands on the list |
| 4 | Consistency | 2 | Sheet, new tab and inline disclosure all drill in; "Booked" in two colours |
| 5 | Error prevention | 3 | Delete, lost and void are confirmed |
| 6 | Recognition | 2 | Meetings and payments link to their deal only by program name |
| 7 | Flexibility | 1 | No new deal or note from the person; no shortcuts |
| 8 | Minimalism | 2 | Empty sections get full cards; Identity Path repeats the name |
| 9 | Error recovery | 3 | Inline and toast errors; the not-found state has a way back |
| 10 | Help | 2 | Tooltips patch labels that should be clearer |
| | **Total** | **22/40** | **Acceptable** |

## 3. Cognitive load
5 of 8 checks fail, so load is **high**: single focus, chunking (Attribution has 10 fields), grouping, hierarchy, and working memory (matching a meeting to its deal).

Decision points with more than 4 options:
- Sheet actions: Record payment, Mark lost, Void, Delete, and Add payment (`opportunity-sheet-summary.tsx:62-75`).
- The first viewport shows 8 status chips.

## 4. Emotional journey
The list hands off cleanly, but the header shows only a name and an email, nothing about what's next. A closer preparing for a call opens a new tab to see the booking answers. Deleting a deal drops you back on the list, away from the person.

## 5. Strengths
- `?opportunityId=` deep links, including legacy deal URLs, open the sheet.
- Destructive dialogs explain the consequence; delete suggests marking the deal lost instead.
- Lifecycle shows the date each stage was reached, the disposition source, and an inactive badge computed at read time (ADR rules 11-12).

## 6. Priority issues
**[P1] The deal isn't the unit the page is organised around**
- **What:** Deals, Meetings, Payments and Timeline are parallel lists (`entity-detail-layout.tsx:22-27`). Attribution appears three times. The screenshot ties the meeting to its deal only through "TestProgram".
- **Why:** a person can have many deals (ADR rule 7), so it gets unclear which deal a meeting belongs to.
- **Fix:** Nest each deal's latest meeting, payments and next task inside its deal card.
- **Command:** `/impeccable layout`

**[P1] Two status vocabularies**
- **What:** The header shows "Lead · active" (`leads.status`, flagged in CONTEXT.md) while Lifecycle shows "Booked · Open". The sheet title says "Opportunity" and its description says "deal". The timeline still shows "Scheduled", a retired status. "Not recorded" is both a meeting state and the empty-date fallback (`entity-detail-formatters.ts:17,26`).
- **Fix:** Put stage and disposition in the header, rename to Deals, and give each concept one badge form.
- **Command:** `/impeccable clarify`

**[P1] No actions, flat hierarchy**
- **What:** The header has no actions, and nothing in `app/` links to `new-opportunity?leadId=`. The only page actions are admin-only, inside the Lifecycle card. Empty Portal Notes, Payments, DM Portal and Custom Fields cards weigh as much as a live deal.
- **Fix:** Add a header action bar (New deal, Add note, copy contact) and a "next up" strip. Collapse empty sections into one line.
- **Command:** `/impeccable distill`

**[P1] Mobile and keyboard can't reach parts of the flow**
- **What:** At 390px the cards overflow and clip "Details" and the dates (owner `.light.390.png`). Desktop list rows open only through `onClick`, with no link (`entity-result-row.tsx:33-36`).
- **Fix:** Put `min-w-0` on the grid children and make the name a real link.
- **Command:** `/impeccable adapt`

**[P2] The sheet breaks navigation**
- **What:** Opening a deal never writes the URL (`opportunity-sheet-context.tsx:51-58`). Delete pushes `/workspace/opportunities`, which redirects to the list (`delete-opportunity-dialog.tsx:80`). The title "Opportunity Detail" names nothing. Void is a filled red button beside the primary action.
- **Fix:** Push the URL on open. After a delete, stay on the person. Put the program in the title. Move destructive actions into an overflow menu.
- **Command:** `/impeccable harden`

## 7. Persona red flags
- **Alex (power user):** Can't start a deal or add a note from the person; no shortcuts.
- **Sam (keyboard or screen reader):** List rows can't be focused. Disposition reason and source live only in a hover tooltip on a non-focusable badge (`entity-lifecycle-section.tsx:58-62`).
- **Casey (closer on a phone):** The 390px layout overflows. The next call isn't shown first. The closer's view is the owner's minus two buttons (closer `.light.1440.png`).

## 8. Minor observations
- Meeting times use the browser's zone and lifecycle dates the business zone, with neither labelled, which CONTEXT.md requires.
- First touch credits "Team Two Closer" while the deal shows "Claudio Closer", unexplained.
- Cosmetic: four timeline dot colours, 10px uppercase labels, and green "Booked" competing with the green money amounts.

## 9. Provocative questions
1. If each deal told its own story, would the page need standalone Meetings and Payments sections?
2. A closer opens this five minutes before a call. Why is the email the first thing they see, not the call?
3. Should the deal be a sheet that hides the person, or a split pane?


## Detector and browser evidence (Assessment B)

CLI detector: 0 findings (exit 0).
Browser: mobile columns 383px inside 310px parent; sheet attribution names get 37px for up to 111px of text; help target 14x14px; attribution toggle 16.5px high; Lead active contrast 4.14:1.
