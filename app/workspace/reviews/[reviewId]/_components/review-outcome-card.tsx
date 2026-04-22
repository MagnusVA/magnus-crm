"use client";

import type { Doc, Id } from "@/convex/_generated/dataModel";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  CalendarPlusIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  ClockIcon,
  DollarSignIcon,
  FileTextIcon,
  UserXIcon,
  XCircleIcon,
} from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import {
  opportunityStatusConfig,
  type OpportunityStatus,
} from "@/lib/status-config";

// ---------------------------------------------------------------------------
// Label maps
// ---------------------------------------------------------------------------

const NO_SHOW_REASON_LABELS: Record<string, string> = {
  no_response: "Lead didn't show up",
  late_cancel: "Lead messaged — couldn't make it",
  technical_issues: "Technical issues",
  other: "Other",
};

const FOLLOW_UP_TYPE_LABELS: Record<string, string> = {
  scheduling_link: "Scheduling link",
  manual_reminder: "Manual reminder",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ActiveFollowUp = {
  _id: Id<"followUps">;
  type: Doc<"followUps">["type"];
  status: "pending";
  createdAt: number;
  reminderScheduledAt?: number;
};

type PaymentRecord = {
  _id: Id<"paymentRecords">;
  amountMinor: number;
  currency: string;
  status: Doc<"paymentRecords">["status"];
  recordedAt: number;
  referenceCode?: string;
  proofFileId?: Id<"_storage">;
  programName?: string | null;
  paymentType?: string | null;
  commissionable?: boolean;
  origin?: Doc<"paymentRecords">["origin"];
  attributedCloserId?: Id<"users"> | null;
  attributedCloserName?: string | null;
  recordedByUserId?: Id<"users">;
  recordedByName?: string | null;
};

type ReviewOutcomeCardProps = {
  opportunity: Doc<"opportunities">;
  meeting: Doc<"meetings">;
  closerName: string;
  paymentRecords: PaymentRecord[];
  lostByUserName: string | null;
  noShowByUserName: string | null;
  activeFollowUp: ActiveFollowUp | null;
};

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatAmount(amountMinor: number, currency: string): string {
  const amount = amountMinor / 100;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function formatDateTime(ts: number): string {
  return format(new Date(ts), "MMM d, yyyy 'at' h:mm a");
}

function formatPaymentTypeLabel(paymentType?: string | null): string {
  switch (paymentType) {
    case "monthly":
      return "Monthly";
    case "split":
      return "Split";
    case "pif":
      return "Paid in Full";
    case "deposit":
      return "Deposit";
    default:
      return "Not set";
  }
}

// ---------------------------------------------------------------------------
// Component
//
// Renders the authoritative outcome audit trail — what the closer actually
// did with this opportunity. This is the "star" card on the admin review
// page: before acknowledging or disputing, the admin needs full visibility
// into the action the closer took.
//
// Branches by opportunity.status:
//   - payment_received      → PaymentSection (all payment records)
//   - lost                  → LostSection (reason, actor, timestamp)
//   - no_show               → NoShowSection (meeting-level no-show data)
//   - meeting_overran + fu  → FollowUpSection (active follow-up details)
//   - meeting_overran       → PendingSection ("no action yet")
//   - anything else         → GenericSection (status label)
// ---------------------------------------------------------------------------

export function ReviewOutcomeCard({
  opportunity,
  meeting,
  closerName,
  paymentRecords,
  lostByUserName,
  noShowByUserName,
  activeFollowUp,
}: ReviewOutcomeCardProps) {
  const statusKey = opportunity.status as OpportunityStatus;
  const statusCfg = opportunityStatusConfig[statusKey];

  const { icon: Icon, tint, title } = outcomeChrome(
    opportunity.status,
    activeFollowUp,
  );

  return (
    <Card className={cn("border", tint.border)}>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span className={cn("flex items-center gap-2", tint.text)}>
            <Icon className={cn("size-4", tint.icon)} aria-hidden />
            {title}
          </span>
          {statusCfg && (
            <Badge className={cn("shrink-0", statusCfg.badgeClass)}>
              {statusCfg.label}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {opportunity.status === "payment_received" && (
          <PaymentSection
            paymentRecords={paymentRecords}
            closerName={closerName}
          />
        )}

        {opportunity.status === "lost" && (
          <LostSection
            opportunity={opportunity}
            lostByUserName={lostByUserName ?? closerName}
          />
        )}

        {opportunity.status === "no_show" && (
          <NoShowSection
            meeting={meeting}
            opportunity={opportunity}
            noShowByUserName={noShowByUserName ?? closerName}
          />
        )}

        {opportunity.status === "meeting_overran" && activeFollowUp && (
          <FollowUpSection
            activeFollowUp={activeFollowUp}
            closerName={closerName}
          />
        )}

        {opportunity.status === "meeting_overran" && !activeFollowUp && (
          <PendingSection />
        )}

        {!["payment_received", "lost", "no_show", "meeting_overran"].includes(
          opportunity.status,
        ) && <GenericSection opportunity={opportunity} />}

        {/* Closer-entered meeting metadata applies to all outcomes.
            `meeting.notes` is deprecated (replaced by meetingComments) but
            still populated by the Calendly invitee.created webhook; keep the
            display so reviewers see Calendly-supplied notes. */}
        {meeting.notes && (
          <div className="space-y-2 border-t pt-3">
            <div>
              <div className="mb-1 flex items-center gap-2 text-muted-foreground">
                <FileTextIcon className="size-3.5" aria-hidden />
                Meeting notes
              </div>
              <p className="whitespace-pre-wrap rounded-md bg-muted/50 p-3 text-sm">
                {meeting.notes}
              </p>
            </div>
          </div>
        )}

        {/* Timing telemetry — always shown when available */}
        {(meeting.startedAt ||
          meeting.stoppedAt ||
          meeting.lateStartDurationMs ||
          meeting.exceededScheduledDurationMs) && (
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 border-t pt-3 text-xs text-muted-foreground">
            {meeting.startedAt && (
              <div>
                <span>Started:</span>{" "}
                <span className="font-mono text-foreground">
                  {format(new Date(meeting.startedAt), "h:mm:ss a")}
                </span>
              </div>
            )}
            {meeting.stoppedAt && (
              <div>
                <span>Stopped:</span>{" "}
                <span className="font-mono text-foreground">
                  {format(new Date(meeting.stoppedAt), "h:mm:ss a")}
                </span>
              </div>
            )}
            {meeting.lateStartDurationMs && meeting.lateStartDurationMs > 0 && (
              <div>
                <span>Late start:</span>{" "}
                <span className="font-mono text-foreground">
                  {formatDurationMs(meeting.lateStartDurationMs)}
                </span>
              </div>
            )}
            {meeting.exceededScheduledDurationMs &&
              meeting.exceededScheduledDurationMs > 0 && (
                <div>
                  <span>Over scheduled:</span>{" "}
                  <span className="font-mono text-foreground">
                    {formatDurationMs(meeting.exceededScheduledDurationMs)}
                  </span>
                </div>
              )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Section components
// ---------------------------------------------------------------------------

function PaymentSection({
  paymentRecords,
  closerName,
}: {
  paymentRecords: PaymentRecord[];
  closerName: string;
}) {
  if (paymentRecords.length === 0) {
    return (
      <p className="italic text-muted-foreground">
        Opportunity is marked as paid, but no payment records were found.
      </p>
    );
  }

  const totalByCurrency = new Map<string, number>();
  for (const p of paymentRecords) {
    if (p.status !== "disputed") {
      totalByCurrency.set(
        p.currency,
        (totalByCurrency.get(p.currency) ?? 0) + p.amountMinor,
      );
    }
  }

  return (
    <div className="space-y-3">
      <div className="text-muted-foreground">
        Attributed to{" "}
        <span className="font-medium text-foreground">
          {paymentRecords[0]?.attributedCloserName ?? closerName}
        </span>
      </div>
      <ul className="space-y-2">
        {paymentRecords.map((p) => (
          <li
            key={p._id}
            className="rounded-md border bg-background/60 p-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-medium">
                <DollarSignIcon
                  className="size-4 text-emerald-600 dark:text-emerald-400"
                  aria-hidden
                />
                {formatAmount(p.amountMinor, p.currency)}
              </div>
              <Badge
                variant="outline"
                className={cn(
                  "text-xs capitalize",
                  p.status === "verified" &&
                    "border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-400",
                  p.status === "disputed" &&
                    "border-red-300 text-red-700 dark:border-red-800 dark:text-red-400",
                )}
              >
                {p.status}
              </Badge>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {p.programName && (
                <div>
                  <span>Program:</span>{" "}
                  <span className="text-foreground">{p.programName}</span>
                </div>
              )}
              <div>
                <span>Payment type:</span>{" "}
                <span className="text-foreground">
                  {formatPaymentTypeLabel(p.paymentType)}
                </span>
              </div>
              <div>
                <span>Revenue:</span>{" "}
                <span className="text-foreground">
                  {p.commissionable === false
                    ? "Non-commissionable"
                    : "Commissionable"}
                </span>
              </div>
              {p.attributedCloserName && (
                <div>
                  <span>Attributed to:</span>{" "}
                  <span className="text-foreground">{p.attributedCloserName}</span>
                </div>
              )}
              {p.origin === "admin_review_resolution" &&
                p.attributedCloserId &&
                p.recordedByUserId &&
                p.attributedCloserId !== p.recordedByUserId && (
                  <div className="col-span-2 italic">
                    Logged on behalf by{" "}
                    <span className="text-foreground">
                      {p.recordedByName ?? "an admin"}
                    </span>
                  </div>
                )}
              {p.referenceCode && (
                <div>
                  <span>Reference:</span>{" "}
                  <span className="font-mono text-foreground">
                    {p.referenceCode}
                  </span>
                </div>
              )}
              <div className="col-span-2">
                <span>Recorded:</span>{" "}
                <span className="text-foreground">
                  {formatDateTime(p.recordedAt)}
                </span>
              </div>
              {p.proofFileId && (
                <div className="col-span-2">
                  <span className="text-emerald-700 dark:text-emerald-400">
                    Proof file attached
                  </span>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
      {totalByCurrency.size > 0 && (
        <div className="flex flex-wrap justify-end gap-3 border-t pt-2 text-sm">
          {Array.from(totalByCurrency.entries()).map(([currency, sum]) => (
            <div key={currency}>
              <span className="text-muted-foreground">Total: </span>
              <span className="font-semibold">
                {formatAmount(sum, currency)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LostSection({
  opportunity,
  lostByUserName,
}: {
  opportunity: Doc<"opportunities">;
  lostByUserName: string;
}) {
  return (
    <div className="space-y-3">
      <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
        {opportunity.lostAt && (
          <div>
            <span className="text-muted-foreground">Marked lost:</span>{" "}
            {formatDateTime(opportunity.lostAt)}
          </div>
        )}
        <div>
          <span className="text-muted-foreground">By:</span>{" "}
          <span className="font-medium">{lostByUserName}</span>
        </div>
      </div>
      <div>
        <div className="mb-1 text-muted-foreground">
          Reason given by the closer
        </div>
        {opportunity.lostReason ? (
          <p className="whitespace-pre-wrap rounded-md bg-muted/50 p-3 text-sm">
            {opportunity.lostReason}
          </p>
        ) : (
          <p className="italic text-muted-foreground">
            No reason provided.
          </p>
        )}
      </div>
    </div>
  );
}

function NoShowSection({
  meeting,
  opportunity,
  noShowByUserName,
}: {
  meeting: Doc<"meetings">;
  opportunity: Doc<"opportunities">;
  noShowByUserName: string;
}) {
  const markedAt = meeting.noShowMarkedAt ?? opportunity.noShowAt;
  return (
    <div className="space-y-3">
      <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
        {markedAt && (
          <div>
            <span className="text-muted-foreground">Marked no-show:</span>{" "}
            {formatDateTime(markedAt)}
          </div>
        )}
        <div>
          <span className="text-muted-foreground">By:</span>{" "}
          <span className="font-medium">{noShowByUserName}</span>
        </div>
        {meeting.noShowReason && (
          <div>
            <span className="text-muted-foreground">Reason:</span>{" "}
            {NO_SHOW_REASON_LABELS[meeting.noShowReason] ??
              meeting.noShowReason}
          </div>
        )}
        {meeting.noShowWaitDurationMs && (
          <div>
            <span className="text-muted-foreground">Wait time:</span>{" "}
            <span className="font-mono">
              {formatDurationMs(meeting.noShowWaitDurationMs)}
            </span>
          </div>
        )}
      </div>
      {meeting.noShowNote && (
        <div>
          <div className="mb-1 text-muted-foreground">Closer note</div>
          <p className="whitespace-pre-wrap rounded-md bg-muted/50 p-3 text-sm">
            {meeting.noShowNote}
          </p>
        </div>
      )}
    </div>
  );
}

function FollowUpSection({
  activeFollowUp,
  closerName,
}: {
  activeFollowUp: ActiveFollowUp;
  closerName: string;
}) {
  return (
    <div className="space-y-2">
      <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
        <div>
          <span className="text-muted-foreground">Type:</span>{" "}
          <span className="font-medium">
            {FOLLOW_UP_TYPE_LABELS[activeFollowUp.type] ?? activeFollowUp.type}
          </span>
        </div>
        <div>
          <span className="text-muted-foreground">Created by:</span>{" "}
          <span className="font-medium">{closerName}</span>
        </div>
        <div>
          <span className="text-muted-foreground">Created:</span>{" "}
          {formatDateTime(activeFollowUp.createdAt)}
        </div>
        {activeFollowUp.reminderScheduledAt && (
          <div>
            <span className="text-muted-foreground">Reminder for:</span>{" "}
            {formatDateTime(activeFollowUp.reminderScheduledAt)}
          </div>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        The opportunity stays in <strong>meeting overran</strong> until the
        follow-up resolves (or the admin disputes this action).
      </p>
    </div>
  );
}

function PendingSection() {
  return (
    <div className="flex items-start gap-2 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
      <ClockIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div>
        The closer has not yet taken an action. Use one of the override
        actions above to resolve this review manually.
      </div>
    </div>
  );
}

function GenericSection({
  opportunity,
}: {
  opportunity: Doc<"opportunities">;
}) {
  return (
    <p className="italic text-muted-foreground">
      Opportunity is currently{" "}
      <strong>{opportunity.status.replace(/_/g, " ")}</strong>. See status
      badge above.
    </p>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function outcomeChrome(
  status: string,
  activeFollowUp: ActiveFollowUp | null,
) {
  if (status === "payment_received") {
    return {
      icon: DollarSignIcon,
      title: "Payment Logged",
      tint: {
        border: "border-emerald-200 dark:border-emerald-800/40",
        text: "text-emerald-800 dark:text-emerald-200",
        icon: "text-emerald-600 dark:text-emerald-400",
      },
    };
  }
  if (status === "lost") {
    return {
      icon: XCircleIcon,
      title: "Marked as Lost",
      tint: {
        border: "border-red-200 dark:border-red-800/40",
        text: "text-red-800 dark:text-red-200",
        icon: "text-red-600 dark:text-red-400",
      },
    };
  }
  if (status === "no_show") {
    return {
      icon: UserXIcon,
      title: "Marked as No-Show",
      tint: {
        border: "border-orange-200 dark:border-orange-800/40",
        text: "text-orange-800 dark:text-orange-200",
        icon: "text-orange-600 dark:text-orange-400",
      },
    };
  }
  if (status === "meeting_overran" && activeFollowUp) {
    return {
      icon: CalendarPlusIcon,
      title: "Follow-Up Scheduled (kept overran)",
      tint: {
        border: "border-violet-200 dark:border-violet-800/40",
        text: "text-violet-800 dark:text-violet-200",
        icon: "text-violet-600 dark:text-violet-400",
      },
    };
  }
  if (status === "meeting_overran") {
    return {
      icon: CircleAlertIcon,
      title: "Pending Closer Action",
      tint: {
        border: "border-yellow-200 dark:border-yellow-800/40",
        text: "text-yellow-800 dark:text-yellow-200",
        icon: "text-yellow-600 dark:text-yellow-400",
      },
    };
  }
  return {
    icon: CheckCircle2Icon,
    title: "Outcome",
    tint: {
      border: "border-border",
      text: "text-foreground",
      icon: "text-muted-foreground",
    },
  };
}

function formatDurationMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m ${seconds}s`;
}
