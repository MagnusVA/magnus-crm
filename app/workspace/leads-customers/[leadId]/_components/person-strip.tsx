"use client";

import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DISPOSITION_LABELS,
  LIFECYCLE_STAGE_LABELS,
  type LifecycleStage,
} from "@/convex/leads/lifecycle";
import { inactiveDays } from "@/convex/lib/respark/settings";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import { formatCash } from "@/lib/closer-pipeline";
import { dealProgramName, paidByCurrency, stripNextStep } from "@/lib/person-page";
import { cn } from "@/lib/utils";
import { whenLabel } from "@/app/workspace/closer/pipeline/_components/deal-cells";
import { useEntityDetail } from "./entity-detail-context";
import { personDate, plural } from "./person-format";
import { usePersonDeals, type PersonDealEntry } from "./person-deals";
import { formatPhone } from "@/lib/phone";

// The full row from @5xl (the sketch's widths); from @xl a fold: person,
// stage and paid on one row, the next step and reach by under them.
const COLUMNS =
  "@xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)] @5xl:grid-cols-[minmax(0,1.5fr)_9.375rem_9.375rem_minmax(0,1.2fr)_18.75rem]";

/**
 * The lifecycle stage as a word on navy, in board text: lifecycle stages
 * aren't deal stages, so they don't take the stage scale. Customer alone is
 * lime, the one figure on the board that is (DESIGN.md, Magnus Lime).
 */
const STAGE_WORD_CLASS: Partial<Record<LifecycleStage, string>> = {
  customer: "text-primary",
};

type Tone = "owed" | "step" | "link" | "overdue" | "quiet";

const TONE_WORD: Record<Tone, string> = {
  owed: "text-warning",
  step: "text-board-foreground",
  link: "text-board-foreground",
  overdue: "text-board-danger",
  quiet: "text-board-foreground",
};

const TONE_DOT: Record<Tone, string> = {
  owed: "bg-warning",
  step: "bg-stage-booked",
  link: "bg-stage-held",
  overdue: "bg-board-danger",
  quiet: "bg-stage-held",
};

/**
 * The person as one row of the departures board: who they are, how far
 * they've got, what they've paid, the next step across their open deals,
 * and how to reach them. The meeting and task strips are its siblings; in a
 * narrow container the cells stack and carry their own labels.
 */
export function PersonStrip() {
  const detail = useEntityDetail();
  const { lead, customerSummary, opportunities, payments, caps } = detail;
  const { setting } = useBusinessDay();
  const now = useNow();
  const deals = usePersonDeals();
  const name = lead.fullName ?? lead.email ?? "Unknown person";

  const since = customerSummary
    ? `Customer since ${personDate(customerSummary.customerSince, setting, now)}`
    : `Lead since ${personDate(lead.firstSeenAt, setting, now)}`;
  const dealCount = opportunities.length === 0 ? "no deals" : plural(opportunities.length, "deal");
  const personLine = `${since} · ${dealCount}${caps.opportunities ? "+" : ""}`;

  return (
    <section
      aria-label="This person"
      className="@container overflow-hidden rounded-xl bg-board text-board-foreground dark:ring-1 dark:ring-board-foreground/10"
    >
      {/* The board is dark in both themes: `dark` scopes the dark theme's
          inks and focus rings to it (DESIGN.md, The Board Is Dark Rule). */}
      <div className="dark">
        <div
          aria-hidden
          className={cn(
            "hidden h-7 items-center gap-x-5 border-b border-board-line px-[18px] font-condensed text-[0.6875rem] font-semibold tracking-[0.14em] text-board-muted uppercase @5xl:grid",
            COLUMNS,
          )}
        >
          <span>Person</span>
          <span>Stage</span>
          <span>Paid</span>
          <span>Next step</span>
          <span className="text-right">Reach by</span>
        </div>
        <div
          className={cn(
            "grid grid-cols-2 gap-x-4 gap-y-3.5 px-4 py-3 @xl:gap-x-5 @5xl:min-h-16 @5xl:items-center @5xl:gap-y-0 @5xl:px-[18px] @5xl:py-2",
            COLUMNS,
          )}
        >
          <StripCell label="Person" className="col-span-2 @xl:col-span-1">
            <h1 className="truncate text-lg leading-tight font-semibold" title={name} translate="no">
              {name}
            </h1>
            <p className="mt-0.5 truncate text-[0.8125rem] text-board-muted" suppressHydrationWarning>
              {personLine}
            </p>
          </StripCell>

          <StripCell label="Stage">
            <StageCell />
          </StripCell>

          <StripCell label="Paid">
            <PaidCell payments={payments} partial={caps.payments} />
          </StripCell>

          <StripCell label="Next step" className="col-span-2 @xl:col-span-1">
            <NextStepCell deals={deals} />
          </StripCell>

          <StripCell label="Reach by" className="col-span-2 @5xl:col-span-1 @5xl:justify-self-end">
            <ReachButtons name={name} phone={lead.phone ?? null} email={lead.email ?? null} />
          </StripCell>
        </div>
      </div>
    </section>
  );
}

function StripCell({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <p className="mb-1 font-condensed text-[0.6875rem] font-semibold tracking-[0.14em] text-board-muted uppercase @5xl:sr-only">
        {label}
      </p>
      {children}
    </div>
  );
}

const WORD = "font-condensed text-[1.0625rem] leading-none font-bold tracking-[0.08em] uppercase";

function StageCell() {
  const { lead, inactiveAfterDays } = useEntityDetail();
  const now = useNow();
  const stage = lead.lifecycleStage;
  const inactiveFor = inactiveDays(lead, inactiveAfterDays, now);
  const detail =
    lead.disposition !== "open"
      ? DISPOSITION_LABELS[lead.disposition]
      : inactiveFor !== null
        ? `Inactive · ${plural(inactiveFor, "day")}`
        : null;
  return (
    <>
      <p className={cn(WORD, "truncate", STAGE_WORD_CLASS[stage] ?? "text-board-foreground")}>
        {LIFECYCLE_STAGE_LABELS[stage]}
      </p>
      {detail ? (
        <p
          className={cn(
            "mt-1 truncate text-[0.8125rem]",
            lead.disposition === "do_not_contact" ? "text-board-danger" : "text-board-muted",
          )}
          suppressHydrationWarning
        >
          {detail}
        </p>
      ) : null}
    </>
  );
}

function PaidCell({
  payments,
  partial,
}: {
  payments: ReadonlyArray<{ currency: string; amountMinor: number; status: string }>;
  partial: boolean;
}) {
  const amounts = paidByCurrency(payments);
  if (amounts.length === 0) {
    return <p className="text-[0.9375rem] font-medium text-board-muted">Nothing paid</p>;
  }
  const [main, ...others] = amounts;
  const count = amounts.reduce((sum, entry) => sum + (entry.paymentCount ?? 0), 0);
  return (
    <>
      <p className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        <span className="font-condensed text-[1.625rem] leading-none font-semibold tabular-nums">
          {formatCash(main.amountMinor, main.currency)}
        </span>
        {others.map((entry) => (
          <span
            key={entry.currency}
            className="font-condensed text-[1.0625rem] leading-none font-semibold tabular-nums"
          >
            {formatCash(entry.amountMinor, entry.currency)}
          </span>
        ))}
      </p>
      <p className="mt-1 text-[0.8125rem] text-board-muted tabular-nums">
        {plural(count, "payment")}
        {partial ? " (partial)" : ""}
      </p>
    </>
  );
}

function programOf(deal: PersonDealEntry) {
  return dealProgramName(deal.item.opportunity) ?? "No program";
}

function NextStepCell({ deals }: { deals: PersonDealEntry[] }) {
  const { setting } = useBusinessDay();
  const now = useNow();
  const next = stripNextStep(deals);

  let word: string;
  let detail: string;
  let tone: Tone;
  switch (next.kind) {
    case "no_open":
      word = "No open deals";
      detail = deals.length === 0 ? "No deals yet" : `${plural(deals.length, "closed deal")}`;
      tone = "quiet";
      break;
    case "not_recorded": {
      word = "Not recorded";
      detail = `${programOf(next.deal)} · call ${personDate(next.callAt, setting, now)}`;
      if (next.others > 0) detail += ` · ${next.others} more owed`;
      tone = "owed";
      break;
    }
    case "none": {
      const deal = next.deal;
      word = "No next step";
      const lastCall = deal.item.opportunity.latestMeetingAt;
      detail = programOf(deal);
      if (!next.owed) {
        const closer = deal.item.closer?.fullName ?? deal.item.closer?.email;
        if (closer) detail += ` · deal of ${closer}`;
      } else if (lastCall && lastCall <= now) {
        detail += ` · last call ${personDate(lastCall, setting, now)}`;
      }
      if (next.others > 0) detail += ` · ${next.others} more`;
      tone = next.owed ? "owed" : "quiet";
      break;
    }
    case "step": {
      const { step } = next;
      detail = programOf(next.deal);
      if (step.kind === "call") {
        word = `Call ${whenLabel(step.at, now, setting)}`;
        tone = "step";
      } else if (step.kind === "task") {
        const verb = step.method === "text" ? "Text back" : "Call back";
        word = step.dueAt === null ? verb : `${verb} ${whenLabel(step.dueAt, now, setting)}`;
        tone = step.dueAt !== null && step.dueAt < now ? "overdue" : "step";
      } else {
        word = step.reschedule ? "Reschedule link" : "Link sent";
        detail = `${detail} · sent ${personDate(step.sentAt, setting, now)}`;
        tone = "link";
      }
      break;
    }
  }

  return (
    <>
      <p className={cn(WORD, "flex min-w-0 items-center gap-2", TONE_WORD[tone])} suppressHydrationWarning>
        <span aria-hidden className={cn("size-2 shrink-0 rounded-full", TONE_DOT[tone])} />
        <span className="truncate" title={word}>
          {word}
        </span>
      </p>
      <p className="mt-1 truncate text-[0.8125rem] text-board-muted tabular-nums" title={detail} suppressHydrationWarning>
        {detail}
      </p>
    </>
  );
}

const BOARD_BUTTON =
  "h-8 border border-board-foreground/15 bg-board-raised px-2.5 text-[0.8125rem] font-semibold text-board-foreground hover:bg-board-raised/70";

function ReachButtons({
  name,
  phone,
  email,
}: {
  name: string;
  phone: string | null;
  email: string | null;
}) {
  const copyEmail = async () => {
    if (!email) return;
    try {
      await navigator.clipboard.writeText(email);
      toast.success("Email copied");
    } catch {
      toast.error("Couldn't copy the email. Select it and copy it instead.");
    }
  };

  if (!phone && !email) {
    return <p className="text-[0.8125rem] text-board-muted">No phone or email on file</p>;
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {phone ? (
        <>
          <Button asChild size="sm" className={BOARD_BUTTON}>
            <a href={`tel:${phone}`} aria-label={`Call ${name} at ${formatPhone(phone)}`}>
              Call
              <span className="font-condensed text-[0.9375rem] tracking-[0.02em] tabular-nums" translate="no">
                {formatPhone(phone)}
              </span>
            </a>
          </Button>
          <Button asChild size="sm" className={BOARD_BUTTON}>
            <a href={`sms:${phone}`} aria-label={`Text ${name}`}>
              Text
            </a>
          </Button>
        </>
      ) : (
        <span className="mr-1 text-[0.8125rem] text-board-muted">No phone on file</span>
      )}
      {email ? (
        <Button
          type="button"
          size="sm"
          className={BOARD_BUTTON}
          onClick={copyEmail}
          title={`Copy ${email}`}
          aria-label={`Copy email ${email}`}
        >
          Copy email
        </Button>
      ) : null}
    </div>
  );
}
