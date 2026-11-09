import { DetailCard } from "@/app/workspace/closer/meetings/_components/detail-card";
import { SHOW_RATE_HELP } from "@/app/workspace/_components/results-recorded";
import { REPORT_TERMS } from "@/lib/reporting/definitions";
import { CLOSE_RATE_HELP, PROGRAM_CLOSE_RATE_HELP, TEAM_CLOSE_RATE_HELP } from "./close-rate";

// What each figure on the page counts, in words, so no definition hides
// behind a help icon (PRODUCT.md, Numbers you can trust).

// Canceled, Moved and Final cash read the reporting dictionary, so they mean
// what they mean on every other page.
const DEFINITIONS: ReadonlyArray<{ term: string; definition: string }> = [
  {
    term: "Calls",
    definition:
      "Meetings scheduled in the range, in every status: upcoming, held, canceled, moved, no-show and not recorded.",
  },
  { term: REPORT_TERMS.canceled.label, definition: REPORT_TERMS.canceled.definition },
  { term: REPORT_TERMS.moved.label, definition: REPORT_TERMS.moved.definition },
  { term: "Show rate", definition: SHOW_RATE_HELP },
  {
    term: REPORT_TERMS.finalCash.label,
    definition: `${REPORT_TERMS.finalCash.definition} Payments recorded in the range, each currency on its own; disputed payments are left out.`,
  },
  { term: "Close rate", definition: TEAM_CLOSE_RATE_HELP },
  { term: "Average sale", definition: "Final cash ÷ the number of final payments, in each currency. A dash when there were none." },
  {
    term: "Phone closers",
    definition: `Every active closer is listed, even with no calls; removed closers keep their history. A closer's close rate: ${CLOSE_RATE_HELP} The Total sums the rows, so its revenue leaves out payments credited to no closer and can be lower than Final cash.`,
  },
  {
    term: "Programs",
    definition: `Calls, held and close rate follow the meeting's booked program; payment sales and revenue follow the payment's own program. A program's close rate: ${PROGRAM_CLOSE_RATE_HELP}`,
  },
];

export function DefinitionsCard() {
  return (
    <DetailCard title="How these are counted" className="min-w-0">
      <dl className="flex flex-col">
        {DEFINITIONS.map(({ term, definition }) => (
          <div key={term} className="grid gap-x-4 gap-y-0.5 border-b px-4 py-2 last:border-b-0 @3xl:grid-cols-[9rem_minmax(0,1fr)]">
            <dt className="text-[13px] font-semibold">{term}</dt>
            <dd className="max-w-[75ch] text-[13px] text-muted-foreground">{definition}</dd>
          </div>
        ))}
      </dl>
    </DetailCard>
  );
}
