import { meetingEventStatusLabel } from "@/lib/status-config";
import { ActivityIcon } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import type { Id } from "@/convex/_generated/dataModel";
import { dealEventStateLabel } from "@/convex/opportunities/stageLabels";
import type { DealOutcome } from "@/convex/opportunities/stages";

type ActivityEvent = {
  _id: Id<"domainEvents">;
  eventType: string;
  source: "closer" | "admin" | "pipeline" | "system";
  occurredAt: number;
  actorUserId?: Id<"users">;
  fromStatus?: string;
  toStatus?: string;
  /** A new deal event's outcomes, beside the stages it holds. */
  fromOutcome?: DealOutcome | null;
  toOutcome?: DealOutcome | null;
  reason?: string;
};

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

const EVENT_LABELS: Record<string, string> = {
  "lead.created": "Lead created",
  "opportunity.created": "Opportunity created",
  "opportunity.status_changed": "Status changed",
  "opportunity.stage_changed": "Stage changed",
  "opportunity.marked_lost": "Marked lost",
  "payment.recorded": "Payment recorded",
};

function formatEventType(eventType: string) {
  return (
    EVENT_LABELS[eventType] ??
    eventType
      .split(".")
      .map((part) => part.replaceAll("_", " "))
      .join(" ")
  );
}

/**
 * A deal event's side: an old event holds a status, a new one a stage with
 * its outcome (docs/plans/phase-5-deal-status.md §4.7). A payment's shows
 * as recorded.
 */
function statusLabel(
  event: ActivityEvent,
  value: string | undefined,
  outcome: DealOutcome | null | undefined,
) {
  if (!value) {
    return null;
  }
  return event.eventType.startsWith("opportunity.")
    ? dealEventStateLabel(value, outcome)
    : meetingEventStatusLabel(event.eventType, value)?.replaceAll("_", " ");
}

function formatStatusChange(event: ActivityEvent) {
  const from = statusLabel(event, event.fromStatus, event.fromOutcome);
  const to = statusLabel(event, event.toStatus, event.toOutcome);
  if (!from && !to) {
    return null;
  }
  if (!from) {
    return `Set to ${to}`;
  }
  if (!to) {
    return `From ${from}`;
  }
  return `${from} to ${to}`;
}

export function OpportunityActivityTimeline({
  events,
  compact = false,
}: {
  events: ActivityEvent[];
  compact?: boolean;
}) {
  const content =
    events.length === 0 ? (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ActivityIcon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>No activity yet</EmptyTitle>
          <EmptyDescription>
            Lifecycle events will appear here as this opportunity changes.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    ) : (
      <ol className="flex flex-col gap-4">
        {events.map((event) => {
          const statusChange = formatStatusChange(event);

          return (
            <li key={event._id} className="grid grid-cols-[auto_1fr] gap-3">
              <div
                aria-hidden="true"
                className="mt-1 size-2 rounded-full bg-primary"
              />
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium">
                    {formatEventType(event.eventType)}
                  </p>
                  <span className="text-xs text-muted-foreground">
                    {event.source}
                  </span>
                </div>
                {statusChange ? (
                  <p className="text-sm text-muted-foreground">
                    {statusChange}
                  </p>
                ) : null}
                {event.reason ? (
                  <p className="whitespace-pre-wrap break-words text-sm">
                    {event.reason}
                  </p>
                ) : null}
                <time
                  className="text-xs text-muted-foreground"
                  dateTime={new Date(event.occurredAt).toISOString()}
                >
                  {dateTimeFormatter.format(new Date(event.occurredAt))}
                </time>
              </div>
            </li>
          );
        })}
      </ol>
    );

  if (compact) {
    return (
      <section className="rounded-md border">
        <div className="border-b p-3">
          <h3 className="text-sm font-semibold">Activity</h3>
        </div>
        <div className="p-3">{content}</div>
      </section>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Activity</CardTitle>
        <CardDescription>
          Recent opportunity and payment events, newest first.
        </CardDescription>
      </CardHeader>
      <CardContent>{content}</CardContent>
    </Card>
  );
}
