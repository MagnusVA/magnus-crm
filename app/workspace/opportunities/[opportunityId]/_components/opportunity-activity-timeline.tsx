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

type ActivityEvent = {
  _id: Id<"domainEvents">;
  eventType: string;
  source: "closer" | "admin" | "pipeline" | "system";
  occurredAt: number;
  actorUserId?: Id<"users">;
  fromStatus?: string;
  toStatus?: string;
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

function formatStatusChange(event: ActivityEvent) {
  if (!event.fromStatus && !event.toStatus) {
    return null;
  }
  if (!event.fromStatus) {
    return `Set to ${event.toStatus?.replaceAll("_", " ")}`;
  }
  if (!event.toStatus) {
    return `From ${event.fromStatus.replaceAll("_", " ")}`;
  }
  return `${event.fromStatus.replaceAll("_", " ")} to ${event.toStatus.replaceAll("_", " ")}`;
}

export function OpportunityActivityTimeline({
  events,
}: {
  events: ActivityEvent[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Activity</CardTitle>
        <CardDescription>
          Recent opportunity and payment events, newest first.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {events.length === 0 ? (
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
                      <p className="whitespace-pre-wrap text-sm">
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
        )}
      </CardContent>
    </Card>
  );
}
