"use client";

import { UsersIcon } from "lucide-react";
import type {
  AttributionCredit,
  AttributionTouch,
} from "@/convex/lib/attribution/detailPayload";
import { cn } from "@/lib/utils";
import { MemberAvatar } from "./member-avatar";

// Every role a deal credits and where each touch came from (CONTEXT.md,
// "Role" and "Channel"; docs/plans/phase-3-attribution.md §6.5).

const ROLE_LABELS: Record<AttributionCredit["role"], string> = {
  lead_gen: "Lead gen",
  setter: "Setter",
  dm_team: "DM team",
  dm_closer: "DM closer",
  closer: "Closer",
};

const CHANNEL_LABELS: Record<AttributionTouch["channel"], string> = {
  lead_gen: "Lead gen",
  dm_portal: "DM portal",
  slack: "Slack",
  calendly: "Calendly",
  side_deal: "Side deal",
};

const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });
const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

const DEFAULT_LABEL_CLASS = "text-xs font-medium text-muted-foreground";

/** The deal's credit, one line per attribution row, then its touches. */
export function DealCreditList({
  credits,
  firstTouch,
  latestTouch,
  labelClassName = DEFAULT_LABEL_CLASS,
  className,
}: {
  credits: readonly AttributionCredit[];
  firstTouch: AttributionTouch | null;
  latestTouch: AttributionTouch | null;
  /** Matches the field labels of the card the list sits in. */
  labelClassName?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-3", className)}>
      <div className="flex min-w-0 flex-col gap-1.5">
        <p className={labelClassName}>Credit</p>
        {credits.length === 0 ? (
          <p className="text-sm text-muted-foreground">No credit recorded.</p>
        ) : (
          <ul className="flex min-w-0 flex-col gap-1.5">
            {credits.map((credit) => (
              <CreditRow key={credit.id} credit={credit} />
            ))}
          </ul>
        )}
      </div>
      <TouchLines
        firstTouch={firstTouch}
        latestTouch={latestTouch}
        labelClassName={labelClassName}
      />
    </div>
  );
}

function CreditRow({ credit }: { credit: AttributionCredit }) {
  const name = credit.name ?? "Unknown";
  return (
    <li className="grid min-w-0 grid-cols-[5rem_minmax(0,1fr)_auto] items-center gap-2 text-sm">
      <span className="truncate text-xs text-muted-foreground">
        {ROLE_LABELS[credit.role]}
      </span>
      <span className="flex min-w-0 items-center gap-1.5">
        {credit.identity ? (
          <MemberAvatar identity={credit.identity} size="sm" />
        ) : (
          <span
            aria-hidden="true"
            className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
          >
            <UsersIcon className="size-3" />
          </span>
        )}
        <span className="truncate font-medium" title={name} translate="no">
          {name}
        </span>
      </span>
      <time
        className="text-xs text-muted-foreground tabular-nums"
        dateTime={new Date(credit.attributedAt).toISOString()}
        title={DATE_TIME_FORMATTER.format(credit.attributedAt)}
      >
        {DATE_FORMATTER.format(credit.attributedAt)}
      </time>
    </li>
  );
}

/** "First touch" and "Latest touch": channel, time, and who when known. */
export function TouchLines({
  firstTouch,
  latestTouch,
  labelClassName = DEFAULT_LABEL_CLASS,
  className,
}: {
  firstTouch: AttributionTouch | null;
  latestTouch: AttributionTouch | null;
  labelClassName?: string;
  className?: string;
}) {
  return (
    <dl className={cn("grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1", className)}>
      <TouchLine label="First touch" touch={firstTouch} labelClassName={labelClassName} />
      <TouchLine label="Latest touch" touch={latestTouch} labelClassName={labelClassName} />
    </dl>
  );
}

function TouchLine({
  label,
  touch,
  labelClassName,
}: {
  label: string;
  touch: AttributionTouch | null;
  labelClassName: string;
}) {
  const parts = touch
    ? [
        CHANNEL_LABELS[touch.channel],
        DATE_TIME_FORMATTER.format(touch.occurredAt),
        touch.teamMemberName,
      ].filter((part): part is string => Boolean(part))
    : [];
  const value = parts.length > 0 ? parts.join(" · ") : "Not recorded";
  return (
    <div className="contents">
      <dt className={cn("pt-0.5", labelClassName)}>{label}</dt>
      <dd className="min-w-0 text-sm wrap-break-word">{value}</dd>
    </div>
  );
}
