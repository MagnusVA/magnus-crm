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
import { formatPhone } from "@/lib/phone";
import { cn } from "@/lib/utils";
import { IDENTIFIER_SOURCE_LABELS, MATCH_LABELS } from "../../_components/booking-review-labels";

// The review page's record cards: the booking as Calendly sent it, then one
// card per person it matched, as fact lists and ruled rows.

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

/** "Nov 4 at 2:15 PM": the calendar date and clock in the tenant's time zone (not the business day, which can be the day before). */
export function dayAndClock(at: number, setting: BusinessDaySetting, now: number) {
  const year = formatter(setting.timeZone, { year: "numeric" });
  const sameYear = year.format(at) === year.format(now);
  const date = formatter(setting.timeZone, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) }).format(at);
  return `${date} at ${formatClock(at, setting.timeZone)}`;
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

/** A dense fact row: a slate label column beside the value. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid min-h-8 grid-cols-[110px_minmax(0,1fr)] items-baseline gap-3 py-1.5">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function Dash() {
  return <span className="text-muted-foreground">—</span>;
}

function Phone({ value }: { value: string | undefined }) {
  return value ? (
    <span className="font-condensed text-[15px] font-semibold tabular-nums">{formatPhone(value)}</span>
  ) : (
    <Dash />
  );
}

export function BookingCard({ review }: { review: Review }) {
  const { setting } = useBusinessDay();
  const now = useNow();
  const { booking } = review;
  const theirs = booking.startTime !== undefined ? inviteeTime(booking.startTime, booking.timezone) : null;

  return (
    <section aria-labelledby="booking-title" className={cn(CARD, "@container/booking")}>
      <div className="flex min-h-11 flex-wrap items-center gap-x-2.5 gap-y-0.5 border-b border-border px-4 py-2">
        <h2 id="booking-title" className="text-[15px] font-semibold">
          The booking
        </h2>
        <span className="text-[13px] text-muted-foreground">What the invitee typed on the Calendly form</span>
      </div>
      {booking.payloadAvailable ? null : (
        <p className="border-b border-border px-4 py-2.5 text-[13px] text-muted-foreground">
          <span className="font-medium text-foreground">Past retention.</span> The full form is past its 30-day retention;
          only the identifiers remain.
        </p>
      )}
      <dl className="grid gap-x-8 px-4 py-2 @2xl/booking:grid-cols-2">
        {booking.inviteeName ? <Fact label="Invitee">{booking.inviteeName}</Fact> : null}
        {booking.email ? <Fact label="Email">{booking.email}</Fact> : null}
        {booking.phone ? (
          <Fact label="Phone">
            <Phone value={booking.phone} />
          </Fact>
        ) : null}
        {booking.socialHandle ? <Fact label="Instagram">@{booking.socialHandle.handle}</Fact> : null}
        {booking.startTime !== undefined ? (
          <Fact label="Call">
            <span className="font-condensed text-[15px] font-semibold tabular-nums">
              {dayAndClock(booking.startTime, setting, now)}
            </span>
            {theirs ? <span className="block text-[13px] text-muted-foreground">{theirs} for the invitee</span> : null}
          </Fact>
        ) : null}
        {booking.eventName ? <Fact label="Event">{booking.eventName}</Fact> : null}
        {booking.hostName ? (
          <Fact label="Host">
            {booking.hostName}
            {booking.hostEmail ? <span className="block text-[13px] text-muted-foreground">{booking.hostEmail}</span> : null}
          </Fact>
        ) : null}
        {booking.bookedVia ? <Fact label="Booked via">{booking.bookedVia}</Fact> : null}
      </dl>
      {booking.answers.length > 0 ? (
        <details className="group border-t border-border">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 text-[14px] font-medium outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset [&::-webkit-details-marker]:hidden">
            Form answers
            <span className="font-condensed text-[15px] font-semibold text-muted-foreground tabular-nums">
              ({booking.answers.length})
            </span>
            <ChevronDownIcon
              aria-hidden="true"
              className="ml-auto size-4 text-muted-foreground transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none"
            />
          </summary>
          <dl className="bg-muted/30">
            {booking.answers.map((answer) => (
              <div key={answer.question} className="border-t border-border px-4 py-2">
                <dt className="text-[13px] text-muted-foreground">{answer.question}</dt>
                <dd className="break-words">{answer.answer}</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
      {booking.meetingId ? (
        <div className="flex min-h-10 items-center border-t border-border px-4">
          <Link href={`/workspace/pipeline/meetings/${booking.meetingId}`} className={cn(detailLinkClass, "ml-auto text-[13px]")}>
            Open the meeting
          </Link>
        </div>
      ) : null}
    </section>
  );
}

function CheckChip({ check }: { check: Person["checks"][number] }) {
  return (
    <li
      className={cn(
        "inline-flex h-5 items-center gap-1 rounded-[4px] px-1.5 font-condensed text-[11px] leading-none font-bold tracking-[0.1em] uppercase",
        check.same ? "bg-muted text-foreground" : "bg-warning-surface text-warning-ink",
      )}
    >
      {check.same ? <CheckIcon aria-hidden="true" className="size-3" strokeWidth={3} /> : null}
      {check.same ? "Same" : "Different"} {check.label}
    </li>
  );
}

function RowsHead({ children }: { children: React.ReactNode }) {
  return <div className={cn("flex min-h-7 items-end border-t border-border px-4 pb-1.5", LABEL)}>{children}</div>;
}

export function PersonCard({ person }: { person: Person }) {
  const { setting } = useBusinessDay();
  const now = useNow();
  const role =
    person.role === "booked"
      ? "Booking went to"
      : `Also matched by ${person.matchedBy.map((via) => MATCH_LABELS[via]).join(" and ")}`;
  const instagram = person.handles.map((handle) => `@${handle.handle}`).join(", ");

  return (
    <section aria-label={`${personName(person)}: ${role}`} className={cn(CARD, "flex flex-col")}>
      <div className="flex min-h-11 flex-wrap items-center gap-x-2.5 gap-y-0.5 border-b border-border px-4 py-2">
        <h3 className="min-w-0 truncate text-[15px] font-semibold">{personName(person)}</h3>
        <span className="text-[13px] text-muted-foreground">{role}</span>
        {person.status === "merged" ? (
          <span className="ml-auto inline-flex h-5 items-center rounded-[4px] bg-muted px-1.5 font-condensed text-[11px] leading-none font-bold tracking-[0.1em] text-muted-foreground uppercase">
            Merged into another person
          </span>
        ) : null}
      </div>

      {person.checks.length > 0 ? (
        <ul aria-label="Compared with the booking" className="flex flex-wrap gap-1.5 border-b border-border px-4 py-2.5">
          {person.checks.map((check) => (
            <CheckChip key={check.label} check={check} />
          ))}
        </ul>
      ) : null}

      <dl className="px-4 py-1.5">
        <Fact label="Email">{person.email || <Dash />}</Fact>
        <Fact label="Phone">
          <Phone value={person.phone} />
        </Fact>
        <Fact label="Instagram">{instagram || <Dash />}</Fact>
        <Fact label="First seen">
          <span className="font-condensed text-[15px] font-semibold tabular-nums">{dayWords(person.firstSeenAt, setting, now)}</span>
        </Fact>
      </dl>

      <RowsHead>Deals · {person.deals.length}</RowsHead>
      {person.deals.length === 0 ? (
        <p className="border-t border-border px-4 py-2.5 text-[13px] text-muted-foreground">No deals.</p>
      ) : (
        <ul aria-label="Deals">
          {person.deals.map((deal) => {
            const closer = deal.closerName ?? deal.hostName;
            const facts = [
              closer ? `Closer ${closer}` : null,
              deal.latestMeetingAt !== undefined ? `Call ${dayAndClock(deal.latestMeetingAt, setting, now)}` : null,
              deal.qualifiedByName ? `Qualified by ${deal.qualifiedByName}` : null,
            ].filter(Boolean);
            return (
              <li key={deal.opportunityId} className="border-t border-border px-4 py-2">
                <div className="flex items-baseline justify-between gap-3">
                  <StageWord position={deal.position} systemLoss={deal.systemLoss} />
                  <span className="text-[13px] text-muted-foreground">
                    Created{" "}
                    <span className="font-condensed text-[14px] font-semibold text-foreground tabular-nums">
                      {dayWords(deal.createdAt, setting, now)}
                    </span>
                  </span>
                </div>
                {facts.length > 0 ? <p className="mt-1 text-[13px] text-muted-foreground">{facts.join(" · ")}</p> : null}
              </li>
            );
          })}
        </ul>
      )}

      {person.identifiers.length > 0 ? (
        <>
          <RowsHead>
            <HelpTip tip="Every email, phone and handle the CRM has on file for this person, and where each came from.">
              Known identifiers
            </HelpTip>
          </RowsHead>
          <ul aria-label="Known identifiers">
            {person.identifiers.map((identifier) => (
              <li
                key={`${identifier.type}:${identifier.value}`}
                className="flex min-h-8 flex-wrap items-baseline justify-between gap-x-3 border-t border-border px-4 py-1.5"
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

      <div className="mt-auto flex min-h-10 items-center border-t border-border px-4">
        <span className="text-[13px] text-muted-foreground">
          {person.deals.length} {person.deals.length === 1 ? "deal" : "deals"}
        </span>
        <Link href={`/workspace/leads-customers/${person.leadId}`} className={cn(detailLinkClass, "ml-auto text-[13px]")}>
          Open person
        </Link>
      </div>
    </section>
  );
}
