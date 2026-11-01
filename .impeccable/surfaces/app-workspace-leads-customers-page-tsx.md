---
version: 1
slug: "app-workspace-leads-customers-page-tsx"
primary_target: "app/workspace/leads-customers/page.tsx"
related_targets: ["app/workspace/leads-customers/new-opportunity/page.tsx","app/workspace/profile/page.tsx"]
---

# Leads & Customers list, New side deal, Profile (`/workspace/leads-customers`)

Mode: Operate. Sixth surface in the world locked on Closer Today; recipes and tokens in `DESIGN.md`. Replaces the old entity browser (a seven-column table of lifecycle badges, "active" pills, "Last signal" and "1 opp / 1 mtg" counts behind help tooltips).

## Scope
Audience: closers and admins on the same composition. It is the tenant's directory: everyone, not only the viewer's deals (My Pipeline is that). Closers come to find a person (by name, phone, email, handle or ID) before or after a call and to see where that person stands; admins to find and check people.
User decisions (2026-11-01): each row shows the person's current deal (newest open deal, else the newest deal of any outcome) with its stage, closer and next step; the list stays the directory (no "Mine" filter); New side deal keeps its own page; the search-first composition (`.impeccable/mocks/leads-customers-b.html`, approved over the seven-column table `.impeccable/mocks/leads-customers.html`). The optional "Needs you" summary line was offered and not taken.
Related: New side deal (`/workspace/leads-customers/new-opportunity`, form in `app/workspace/opportunities/new/_components`) and Profile (`/workspace/profile`) move into the world in the same pass; the command palette's closer entries become Today, My Pipeline, Leads & Customers.

## Direction contract
THESIS: A directory you search, not a spreadsheet you scan: the search field is the page's hero on a navy band, and each person is one ruled two-line row that reads left to right as who, their deal, what happens next, and money. Refuses the seven equal columns of badges and counts.
OWN-WORLD: Same as Closer Today: navy band (the board's sibling, like the strips), paper ground, white ruled card, lime only for the page's primary button (New side deal) and the active tab's underline, Barlow and Barlow Condensed with tabular figures, stage words from the stage scale, amber only for "No next step" / "Not recorded" on a deal the viewer can act on.
STORY: The visitor lands with the cursor in the search field, types part of a name, phone or handle, sees the matching people with their deal and next step, and opens the person page.
FIRST VIEWPORT: Navy sidebar, white top bar. A navy band: "Leads & Customers" (display h1) with a 13px board-muted line, the lime New side deal button right; a 44px search field on board-raised, focused on load, with a `/` hint; under a board-line rule, tabs ALL · LEADS · CUSTOMERS · PROSPECTS in condensed uppercase with a 2px lime underline on the active one, and "Newest activity first" (or "N matches") right. Under the band, one white ruled card of 60px rows in four columns: PERSON (15px semibold name; 13px slate contact line: phone in condensed, else email, else handle · platform); DEAL (program, then the stage as a condensed stage word in its stage ink; 13px slate line "Your deal" / "Deal of {closer}" / "No closer", plus "· +N open" when more open deals); NEXT STEP (the next-step fact in the person-deal-card footer style, verb in medium slate then condensed figure; amber flag "No next step" / "Not recorded · Jun 18 call" only when the viewer can act; slate "No next step" otherwise; slate "No open deal" for closed; 13px slate "Last activity Oct 30" under it); PAID (right-aligned 20px condensed figure; a quiet slate "—" when nothing is paid; under it an 11px condensed lifecycle word: LEAD in slate, CUSTOMER SINCE SEP 9 in lime ink, PROSPECT in slate). About ten rows show at 1440×900.
FORM: Search-first band and two-line rows (user's choice of sketch B over the seven-column table); seed:eda039a71acf04eb (rolled after the user chose sketch B; the user's choice governs and the dealt structures were not presented)
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Data rules
- Rows come from `api.leadCustomers.queries.listEntities` (paginated, 25 a page) and `searchEntities` (up to 50); each row now carries `deal: ListDeal | null` (`convex/leadCustomers/listDeal.ts`): program name, stage position and system loss, closer name, `isMine`, `canAct`, `nextStep` ({callAt, task} for open deals, as My Pipeline), `otherOpenCount`.
- Next step words: the same resolver as My Pipeline (`lib/closer-pipeline.ts` `resolveNextStep`, `StepWords` in `app/workspace/closer/pipeline/_components/deal-cells.tsx`): an upcoming call, else the open task, else a passed call with no result ("Not recorded"), else "No next step".
- Paid: the projection's `totalPaidMinor` in `paymentCurrency`. When a customer's payments are in several currencies the projection has no single currency: show "Several currencies" in slate, never a summed figure.
- Dates are business days (`useBusinessDay`), year only outside this year.

## States
- Browse (newest activity first), search with matches ("3 matches for 'ana'"), search with none (what was searched, a hint to try phone or email, Clear search), a tab with nobody, loading (skeleton rows at 60px), reloading (kept rows at 60% while a new tab or search loads), Show 25 more.
- A person with no deal (a lead gen capture or Slack qualification without a deal): DEAL reads "No deal yet" in slate, NEXT STEP blank but the activity line.
- Phones: rows fold to two stacked blocks (person with lifecycle word right; deal and next step under it).
