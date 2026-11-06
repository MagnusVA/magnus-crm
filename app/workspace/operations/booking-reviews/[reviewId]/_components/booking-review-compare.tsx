"use client";

import Link from "next/link";
import type { FunctionReturnType } from "convex/server";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import type { api } from "@/convex/_generated/api";
import { formatClock } from "@/app/workspace/closer/_components/today-time";
import { detailLinkClass } from "@/app/workspace/closer/meetings/_components/detail-card";
import { StageWord } from "@/app/workspace/closer/pipeline/_components/deal-cells";
import { CARD, HelpTip, LABEL } from "@/app/workspace/team/_components/team-ui";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import { businessDateForInstant, type BusinessDaySetting } from "@/lib/businessDay";
import { normalizeEmail, normalizePhone, normalizeSocialHandle, type SocialPlatformType } from "@/convex/lib/normalization";
import { SOCIAL_PLATFORMS } from "@/convex/lib/socialPlatform";
import { formatPhone } from "@/lib/phone";
import { cn } from "@/lib/utils";
import { IDENTIFIER_SOURCE_LABELS, MATCH_LABELS } from "../../_components/booking-review-labels";

// The review page's one comparison: the booking in the first column, one
// column per person it matched, a row per detail with a check where the
// person's value matches the booking's. Under it the booking's other facts,
// each person's deals and identifiers, and the form answers, folded.

export type Review = NonNullable<FunctionReturnType<typeof api.pipeline.bookingReviews.get>>;
export type Person = Review["people"][number];

export const personName = (person: Person | undefined) => person?.name ?? "Unnamed person";

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string, options: Intl.DateTimeFormatOptions) {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  let cached = formatters.get(key);
  if (!cached) {
    cached = new Intl.DateTimeFormat("en-US", { timeZone, ...options });
    formatters.set(key, cached);
  }
  return cached;
}

/** "Nov 4", or "Nov 4, 2025" outside this year: the business day an instant falls on. */
export function dayWords(at: number, setting: BusinessDaySetting, now: number) {
  const day = businessDateForInstant(at, setting);
  const sameYear = day.slice(0, 4) === businessDateForInstant(now, setting).slice(0, 4);
  return formatter("UTC", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) }).format(
    Date.parse(`${day}T12:00:00Z`),
  );
}

/** "Nov 4, 2:15 PM": the calendar date and clock in the tenant's time zone (not the business day, which can be the day before). */
export function dayAndClock(at: number, setting: BusinessDaySetting, now: number) {
  const year = formatter(setting.timeZone, { year: "numeric" });
  const sameYear = year.format(at) === year.format(now);
  const date = formatter(setting.timeZone, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) }).format(at);
  return `${date}, ${formatClock(at, setting.timeZone)}`;
}

function inviteeTime(at: number, timeZone: string | undefined) {
  if (!timeZone) return null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone,
      timeZoneName: "short",
    }).format(at);
  } catch {
    return null;
  }
}

export function roleWords(person: Person) {
  return person.role === "booked"
    ? "Booking went to"
    : `Also matched by ${person.matchedBy.map((via) => MATCH_LABELS[via]).join(" and ")}`;
}

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

// ---------------------------------------------------------------------------
// What each cell holds

/** same: matches the booking; different: doesn't; plain: not compared. */
type Mark = "same" | "different" | "plain";
/** `sameAsBooking`: the value is the booking's, so the cell just says "Same". */
type Cell = { text: string | null; mark: Mark; figure?: boolean; sameAsBooking?: boolean; wraps?: boolean };
type RowKey = "name" | "email" | "phone" | "instagram" | "firstSeen" | "deals";

const ROWS: { key: RowKey; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "instagram", label: "Instagram" },
  { key: "firstSeen", label: "First seen" },
  { key: "deals", label: "Deals" },
];

const CHECK_LABEL = { name: "name", email: "email", phone: "phone", instagram: "Instagram" } as const;

function markOf(
  person: Person,
  key: keyof typeof CHECK_LABEL,
  text: string | null,
  bookingText: string | null,
  platform: SocialPlatformType = "instagram",
): Mark {
  const check = person.checks.find((entry) => entry.label === CHECK_LABEL[key]);
  if (check) return check.same ? "same" : "different";
  // Names match by similarity, which only the server's check knows.
  if (key === "name" || !text || !bookingText) return "plain";
  // Compare the way the server matches, so "+1 415-555-2671" and
  // "+14155552671" agree; a value that doesn't normalise isn't compared.
  const normalize =
    key === "email" ? normalizeEmail : key === "phone" ? normalizePhone : (value: string) => normalizeSocialHandle(value, platform);
  const ours = normalize(text);
  const theirs = normalize(bookingText);
  if (ours === undefined || theirs === undefined) return "plain";
  return ours === theirs ? "same" : "different";
}

/** The newest deal, whose stage word stands in the Deals row. */
function newestDeal(person: Person) {
  return person.deals.reduce<Person["deals"][number] | undefined>(
    (newest, deal) => (!newest || deal.createdAt > newest.createdAt ? deal : newest),
    undefined,
  );
}

function bookingCells(review: Review): Record<RowKey, Cell> {
  const { booking } = review;
  return {
    name: { text: booking.inviteeName ?? null, mark: "plain", wraps: true },
    email: { text: booking.email ?? null, mark: "plain" },
    phone: { text: booking.phone ? formatPhone(booking.phone) : null, mark: "plain", figure: true },
    instagram: { text: booking.socialHandle ? `@${booking.socialHandle.handle}` : null, mark: "plain" },
    firstSeen: { text: null, mark: "plain" },
    deals: { text: null, mark: "plain" },
  };
}

function personCells(review: Review, person: Person, setting: BusinessDaySetting, now: number): Omit<Record<RowKey, Cell>, "deals"> {
  const { booking } = review;
  const same = (label: (typeof CHECK_LABEL)[keyof typeof CHECK_LABEL]) =>
    person.checks.some((check) => check.label === label && check.same);
  const known = (type: string) => person.identifiers.filter((identifier) => identifier.type === type).map((i) => i.value);
  const platform = booking.socialHandle?.platform ?? "instagram";

  // A match shows the value both share; otherwise the person's own.
  const email = same("email") && booking.email ? booking.email : (person.email ?? known("email")[0] ?? null);
  const phone = same("phone") && booking.phone ? booking.phone : (person.phone ?? known("phone")[0] ?? null);
  const handles = person.handles.filter((handle) => handle.type === platform).map((handle) => handle.handle);
  const handle =
    same("Instagram") && booking.socialHandle
      ? booking.socialHandle.handle
      : ([...handles, ...known(platform)][0] ?? null);

  const emailMark = markOf(person, "email", email, booking.email ?? null);
  const phoneMark = markOf(person, "phone", phone, booking.phone ?? null);
  const knownPlatform = SOCIAL_PLATFORMS.find((candidate) => candidate === platform) ?? "other_social";
  const handleMark = markOf(person, "instagram", handle, booking.socialHandle?.handle ?? null, knownPlatform);
  return {
    name: {
      text: person.name ?? null,
      mark: markOf(person, "name", person.name ?? null, booking.inviteeName ?? null),
      wraps: true,
    },
    email: { text: email, mark: emailMark, sameAsBooking: emailMark === "same" && email === booking.email },
    phone: {
      text: phone ? formatPhone(phone) : null,
      mark: phoneMark,
      figure: true,
      sameAsBooking: phoneMark === "same" && phone === booking.phone,
    },
    instagram: {
      text: handle ? `@${handle}` : null,
      mark: handleMark,
      sameAsBooking: handleMark === "same" && handle === booking.socialHandle?.handle,
    },
    firstSeen: { text: dayWords(person.firstSeenAt, setting, now), mark: "plain", figure: true },
  };
}

// ---------------------------------------------------------------------------
// Pieces

function Dash() {
  return <span className="text-muted-foreground">—</span>;
}

function CellValue({ cell }: { cell: Cell }) {
  if (!cell.text) return <Dash />;
  if (cell.sameAsBooking) {
    return (
      <span title={cell.text} className="flex items-center gap-1.5 text-foreground">
        <CheckIcon aria-hidden="true" className="size-3.5 shrink-0" strokeWidth={3} />
        Same
        <span className="sr-only">: {cell.text}</span>
      </span>
    );
  }
  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-1.5 py-1.5",
        cell.mark === "different" ? "text-muted-foreground" : "text-foreground",
      )}
    >
      {cell.mark === "same" ? (
        <CheckIcon aria-hidden="true" className="size-3.5 shrink-0" strokeWidth={3} />
      ) : null}
      <span
        title={cell.text}
        className={cn(
          "min-w-0",
          // A long name takes a second line rather than losing its end.
          cell.wraps ? "leading-tight break-words" : "truncate",
          cell.figure && "font-condensed text-[15px] font-semibold tabular-nums",
        )}
      >
        {cell.text}
      </span>
      {cell.mark === "same" ? <span className="sr-only">, same</span> : null}
      {cell.mark === "different" ? <span className="sr-only">, different</span> : null}
    </span>
  );
}

function DealsValue({ person }: { person: Person }) {
  const newest = newestDeal(person);
  if (!newest) return <span className="font-condensed text-[15px] font-semibold text-muted-foreground tabular-nums">0</span>;
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <span className="font-condensed text-[15px] font-semibold tabular-nums">{person.deals.length}</span>
      <StageWord position={newest.position} systemLoss={newest.systemLoss} className="truncate" />
    </span>
  );
}

function MergedMark({ person, review }: { person: Person; review: Review }) {
  if (person.status !== "merged") return null;
  const into = review.people.find((other) => other.leadId === person.mergedIntoLeadId);
  return (
    <HelpTip
      tip={into ? `Already merged into ${personName(into)}.` : "Already merged into another person."}
      className="font-condensed text-[11px] leading-none font-bold tracking-[0.1em] text-muted-foreground uppercase"
    >
      Merged
    </HelpTip>
  );
}

function BookingHead({ review }: { review: Review }) {
  return (
    <>
      <span className={cn(LABEL, "block")}>This booking</span>
      <span className="block text-[13px] text-muted-foreground">From the Calendly form</span>
      {review.booking.meetingId ? (
        <Link href={`/workspace/pipeline/meetings/${review.booking.meetingId}`} className={cn(detailLinkClass, "text-[13px]")}>
          Open the meeting
        </Link>
      ) : null}
    </>
  );
}

function PersonHead({ person, review, as: Heading = "span" }: { person: Person; review: Review; as?: "span" | "h3" }) {
  return (
    <>
      <Heading className="block text-[15px] leading-tight font-semibold break-words">
        {personName(person)}
      </Heading>
      <span className="block truncate text-[13px] text-muted-foreground">{roleWords(person)}</span>
      <span className="flex items-center gap-2.5">
        <Link href={`/workspace/leads-customers/${person.leadId}`} className={cn(detailLinkClass, "text-[13px]")}>
          Open person
        </Link>
        <MergedMark person={person} review={review} />
      </span>
    </>
  );
}

const LEGEND_TIP =
  "A check means the person has the booking's value; Same means exactly the booking's. A slate value differs from it. Names count when they're close. First seen and Deals aren't compared.";

function Legend() {
  return (
    <HelpTip tip={LEGEND_TIP} className="text-[12px] font-normal whitespace-nowrap text-muted-foreground">
      How to read
    </HelpTip>
  );
}

// ---------------------------------------------------------------------------
// The card

export function CompareCard({ review }: { review: Review }) {
  const { setting } = useBusinessDay();
  const now = useNow();
  const { booking } = review;
  const theirs = booking.startTime !== undefined ? inviteeTime(booking.startTime, booking.timezone) : null;
  const bookingRow = bookingCells(review);
  const people = review.people.map((person) => ({ person, cells: personCells(review, person, setting, now) }));
  const columns = people.length + 1;

  const facts = [
    theirs ? { label: "Their time", value: theirs } : null,
    booking.hostName
      ? { label: "Host", value: booking.hostEmail ? `${booking.hostName} · ${booking.hostEmail}` : booking.hostName }
      : null,
    booking.bookedVia ? { label: "Booked via", value: booking.bookedVia } : null,
  ].filter((fact) => fact !== null);

  return (
    <section aria-label="The booking and the people it matched" className={cn(CARD, "@container/cmp")}>
      {booking.payloadAvailable ? null : (
        <p className="border-b border-border px-4 py-2 text-[13px] text-muted-foreground">
          The form is past its 30-day retention; only the identifiers remain.
        </p>
      )}

      {/* From @2xl of the card: one table, a column per record. */}
      <div className="hidden overflow-x-auto @2xl/cmp:block">
        <table className="w-full table-fixed border-collapse text-[14px]" style={{ minWidth: 88 + columns * 130 }}>
          {/* The booking's column keeps room for a whole email. */}
          <colgroup>
            {[
              { key: "label", className: "w-[5.5rem]" },
              { key: "booking", className: columns > 3 ? "w-[24%]" : undefined },
              ...people.map(({ person }) => ({ key: person.leadId, className: undefined })),
            ].map((col) => (
              <col key={col.key} className={col.className} />
            ))}
          </colgroup>
          <thead>
            <tr className="align-top">
              <td className="py-2.5 pl-4 align-bottom">
                <Legend />
              </td>
              <th scope="col" className="bg-muted/40 px-2.5 py-2 text-left font-normal">
                <BookingHead review={review} />
              </th>
              {people.map(({ person }) => (
                <th key={person.leadId} scope="col" className="min-w-0 px-2.5 py-2 text-left font-normal">
                  <PersonHead person={person} review={review} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => (
              <tr key={row.key} className="h-[34px] border-t border-border">
                <th scope="row" className="pl-4 text-left text-[13px] font-normal text-muted-foreground">
                  {row.label}
                </th>
                <td className="bg-muted/40 px-2.5">
                  <CellValue cell={bookingRow[row.key]} />
                </td>
                {people.map(({ person, cells }) => (
                  <td key={person.leadId} className="px-2.5">
                    {row.key === "deals" ? <DealsValue person={person} /> : <CellValue cell={cells[row.key]} />}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Below @2xl: a block per record, label and value rows, marks kept. */}
      <div className="@2xl/cmp:hidden">
        <div className="relative bg-muted/40 px-4 py-2.5">
          <span className="absolute top-2 right-4">
            <Legend />
          </span>
          <BookingHead review={review} />
          <BlockRows cells={bookingRow} />
        </div>
        {people.map(({ person, cells }) => (
          <div key={person.leadId} className="border-t border-border px-4 py-2.5">
            <PersonHead person={person} review={review} as="h3" />
            <BlockRows cells={cells} person={person} />
          </div>
        ))}
      </div>

      {facts.length > 0 ? (
        <dl className="flex flex-wrap gap-x-6 gap-y-1 border-t border-border px-4 py-2 text-[14px]">
          {facts.map((fact) => (
            <div key={fact.label} className="flex min-w-0 items-baseline gap-2">
              <dt className={LABEL}>{fact.label}</dt>
              <dd className="min-w-0 break-words">{fact.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {people.map(({ person }) => (
        <PersonDetails key={person.leadId} person={person} />
      ))}

      {booking.answers.length > 0 ? (
        <Fold
          summary={
            <>
              Form answers
              <span className="font-condensed text-[15px] font-semibold text-muted-foreground tabular-nums">
                ({booking.answers.length})
              </span>
            </>
          }
        >
          <dl>
            {booking.answers.map((answer) => (
              <div key={answer.question} className="border-t border-border px-4 py-2">
                <dt className="text-[13px] text-muted-foreground">{answer.question}</dt>
                <dd className="break-words">{answer.answer}</dd>
              </div>
            ))}
          </dl>
        </Fold>
      ) : null}
    </section>
  );
}

function BlockRows({ cells, person }: { cells: Partial<Record<RowKey, Cell>>; person?: Person }) {
  return (
    <dl className="mt-1.5">
      {ROWS.map((row) => {
        const cell = cells[row.key];
        if (!person && (row.key === "firstSeen" || row.key === "deals")) return null;
        return (
          <div key={row.key} className="grid min-h-8 grid-cols-[6rem_minmax(0,1fr)] items-center gap-3 border-t border-border/70 text-[14px]">
            <dt className="text-[13px] text-muted-foreground">{row.label}</dt>
            <dd className="min-w-0">
              {row.key === "deals" && person ? <DealsValue person={person} /> : cell ? <CellValue cell={cell} /> : <Dash />}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function Fold({ summary, children }: { summary: React.ReactNode; children: React.ReactNode }) {
  return (
    <details className="group border-t border-border">
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 px-4 text-[14px] font-medium outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset [&::-webkit-details-marker]:hidden">
        {summary}
        <ChevronDownIcon
          aria-hidden="true"
          className="ml-auto size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none"
        />
      </summary>
      <div className="bg-muted/30">{children}</div>
    </details>
  );
}

/** One person's deals and known identifiers, folded under the table. */
function PersonDetails({ person }: { person: Person }) {
  const { setting } = useBusinessDay();
  const now = useNow();
  return (
    <Fold
      summary={
        <>
          <span className="min-w-0 truncate">{personName(person)}</span>
          <span className="shrink-0 text-[13px] font-normal text-muted-foreground">
            {plural(person.deals.length, "deal")} · {plural(person.identifiers.length, "identifier")}
          </span>
        </>
      }
    >
      {person.deals.length === 0 ? (
        <p className="border-t border-border px-4 py-2 text-[13px] text-muted-foreground">No deals.</p>
      ) : (
        <ul aria-label={`${personName(person)}: deals`}>
          {person.deals.map((deal) => {
            const closer = deal.closerName ?? deal.hostName;
            const facts = [
              `Created ${dayWords(deal.createdAt, setting, now)}`,
              closer ? `Closer ${closer}` : null,
              deal.latestMeetingAt !== undefined ? `Call ${dayAndClock(deal.latestMeetingAt, setting, now)}` : null,
              deal.qualifiedByName ? `Qualified by ${deal.qualifiedByName}` : null,
            ].filter(Boolean);
            return (
              <li
                key={deal.opportunityId}
                className="flex min-h-9 flex-wrap items-baseline gap-x-3 gap-y-0.5 border-t border-border px-4 py-2"
              >
                <StageWord position={deal.position} systemLoss={deal.systemLoss} className="w-32 shrink-0" />
                <span className="text-[13px] text-muted-foreground">{facts.join(" · ")}</span>
              </li>
            );
          })}
        </ul>
      )}
      {person.identifiers.length > 0 ? (
        <>
          <div className={cn("flex min-h-7 items-end border-t border-border px-4 pb-1.5", LABEL)}>
            <HelpTip tip="Every email, phone and handle the CRM has on file for this person, and where each came from.">
              Known identifiers
            </HelpTip>
          </div>
          <ul aria-label={`${personName(person)}: known identifiers`}>
            {person.identifiers.map((identifier) => (
              <li
                key={`${identifier.type}:${identifier.value}`}
                className="flex min-h-8 flex-wrap items-baseline gap-x-3 border-t border-border px-4 py-1.5"
              >
                <span className="min-w-0 font-mono text-[12.5px] break-all">{identifier.value}</span>
                <span className="text-[13px] text-muted-foreground">
                  {IDENTIFIER_SOURCE_LABELS[identifier.source] ?? identifier.source} · {dayWords(identifier.createdAt, setting, now)}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Fold>
  );
}
