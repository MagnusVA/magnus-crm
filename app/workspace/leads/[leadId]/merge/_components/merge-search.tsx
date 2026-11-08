"use client";

import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ChevronRightIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { useKeptWhileLoading } from "@/app/workspace/operations/lead-gen/_components/use-kept-while-loading";
import { StatusWord } from "@/app/workspace/settings/_components/settings-ui";
import { CARD, CardHead, plural } from "@/app/workspace/team/_components/team-ui";
import { formatPhone } from "@/lib/phone";
import { cn } from "@/lib/utils";
import { LeadSearchInput } from "../../../_components/lead-search-input";
import { personLabel, personWord } from "./merge-format";
import { ResultRowsSkeleton } from "./merge-skeleton";

export type PickerPerson = FunctionReturnType<typeof api.leads.queries.searchLeadsForPicker>[number];

/** searchLeadsForPicker reads at most this many people. */
const SEARCH_CAP = 20;

/**
 * Step one: find the person to keep. Active people and customers alike; the
 * source is left out of its own results. A new search keeps the last rows
 * at 60% until its results land.
 */
export function MergeSearchCard({
  sourceLeadId,
  searchTerm,
  onSearchTermChange,
  onSelect,
}: {
  sourceLeadId: Id<"leads">;
  searchTerm: string;
  onSearchTermChange: (term: string) => void;
  onSelect: (person: PickerPerson) => void;
}) {
  const searching = searchTerm.length >= 2;
  const results = useQuery(api.leads.queries.searchLeadsForPicker, searching ? { searchTerm } : "skip");
  const kept = useKeptWhileLoading(searching ? results : undefined, searchTerm);
  const people = kept.data?.filter((person) => person._id !== sourceLeadId);
  const reloading = searching && kept.reloading;

  let meta: string | undefined;
  if (searching && results === undefined) meta = "Searching…";
  else if (searching && people && people.length > 0) meta = plural(people.length, "match", "matches");

  return (
    <section aria-labelledby="merge-search-title" className={cn(CARD, "@container/search")}>
      <CardHead title={<span id="merge-search-title">Person to keep</span>} meta={meta} />
      <div className="px-4 py-3 [&>div]:max-w-none @xl/search:max-w-md">
        <LeadSearchInput value={searchTerm} onChange={onSearchTermChange} />
      </div>
      <div className="border-t border-border" aria-live="polite" aria-busy={reloading || undefined}>
        {!searching ? (
          <SectionEmpty title="Type at least 2 characters to search." />
        ) : people === undefined ? (
          <ResultRowsSkeleton />
        ) : people.length === 0 ? (
          <SectionEmpty title={`No one matches “${kept.phrase}”.`}>
            Try an email, a phone number or a handle. People already merged don&apos;t show.
          </SectionEmpty>
        ) : (
          <div className={cn("transition-opacity duration-200 motion-reduce:transition-none", reloading && "opacity-60")}>
            <ul aria-label="Matching people">
              {people.map((person) => (
                <ResultRow key={person._id} person={person} onSelect={onSelect} />
              ))}
            </ul>
            {(kept.data?.length ?? 0) >= SEARCH_CAP ? (
              <p className="border-t border-border px-4 py-2.5 text-[13px] text-muted-foreground">
                The first {SEARCH_CAP} matches. Type more of the name or email to narrow them.
              </p>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}

/** One 44px line: name, email (else phone), status word; two lines below @xl of the card. */
function ResultRow({ person, onSelect }: { person: PickerPerson; onSelect: (person: PickerPerson) => void }) {
  const label = personLabel(person);
  const phone = person.phone ? formatPhone(person.phone) : null;
  const contact = person.email && person.email !== label ? person.email : phone !== label ? phone : null;
  const { word, tone } = personWord(person.status);
  return (
    <li className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={() => onSelect(person)}
        className="grid min-h-11 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-1.5 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset @xl/search:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)_5.5rem_1rem] @xl/search:gap-x-4"
      >
        <span className="min-w-0">
          <span className="block truncate leading-5 font-semibold" translate="no">
            {label}
          </span>
          {contact ? (
            <span className="block truncate text-[13px] leading-[18px] text-muted-foreground @xl/search:hidden" translate="no">
              {contact}
            </span>
          ) : null}
        </span>
        <span className="hidden truncate text-muted-foreground @xl/search:block" translate="no">
          {contact ?? "—"}
        </span>
        <StatusWord tone={tone}>{word}</StatusWord>
        <ChevronRightIcon aria-hidden="true" className="hidden size-4 text-muted-foreground @xl/search:block" />
      </button>
    </li>
  );
}
