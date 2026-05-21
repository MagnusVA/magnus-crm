"use client";

import type { ReactNode } from "react";
import {
  CalendarCheckIcon,
  ClockIcon,
  DollarSignIcon,
  MessageSquareTextIcon,
  PhoneCallIcon,
  TagsIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

export type EntityAttribution = {
  slackQualification: {
    slackUserId: string;
    slackUserLabel: string;
    submittedAt: number;
    resultKind: string;
  } | null;
  bookedProgram: { name: string } | null;
  soldProgram: { name: string } | null;
  dmAttribution: {
    status: "mapped" | "unmapped" | "internal" | "none";
    teamName: string | null;
    dmCloserName: string | null;
    rawSource: string | null;
    rawMedium: string | null;
  };
  phoneCloser: { name: string } | null;
  timeline: {
    qualifiedAt: number | null;
    firstBookedAt: number | null;
    firstMeetingAt: number | null;
    paymentReceivedAt: number | null;
  };
};

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatDateTime(timestamp: number | null | undefined) {
  if (!timestamp) {
    return "Not recorded";
  }

  return DATE_TIME_FORMATTER.format(new Date(timestamp));
}

function formatToken(value: string) {
  return value.replace(/_/g, " ");
}

function attributionStatusLabel(status: EntityAttribution["dmAttribution"]["status"]) {
  if (status === "none") return "No UTM";
  return formatToken(status);
}

export function EntityAttributionCard({
  attribution,
}: {
  attribution: EntityAttribution | null;
}) {
  if (!attribution) {
    return null;
  }

  const dmStatus = attribution.dmAttribution.status;
  const dmTeam =
    attribution.dmAttribution.teamName ??
    attribution.dmAttribution.rawSource ??
    "None";
  const dmCloser =
    attribution.dmAttribution.dmCloserName ??
    attribution.dmAttribution.rawMedium ??
    "None";

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <TagsIcon aria-hidden="true" className="size-4" />
              Attribution
            </CardTitle>
            <CardDescription>
              Qualification, booking, sales, and payment context.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant={dmStatus === "mapped" ? "secondary" : "outline"}>
              {attributionStatusLabel(dmStatus)}
            </Badge>
            {attribution.slackQualification ? (
              <Badge variant="outline">
                {formatToken(attribution.slackQualification.resultKind)}
              </Badge>
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <AttributionField
            icon={<MessageSquareTextIcon aria-hidden="true" />}
            label="Slack qualifier"
            value={
              attribution.slackQualification?.slackUserLabel ??
              "Not Slack-qualified"
            }
          />
          <AttributionField
            icon={<CalendarCheckIcon aria-hidden="true" />}
            label="Booked program"
            value={attribution.bookedProgram?.name ?? "Unmapped"}
          />
          <AttributionField
            icon={<DollarSignIcon aria-hidden="true" />}
            label="Sold program"
            value={attribution.soldProgram?.name ?? "No payment yet"}
          />
          <AttributionField label="DM team" value={dmTeam} />
          <AttributionField label="DM closer" value={dmCloser} />
          <AttributionField
            icon={<PhoneCallIcon aria-hidden="true" />}
            label="Phone closer"
            value={attribution.phoneCloser?.name ?? "Unassigned"}
          />
        </div>

        <Separator />

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <AttributionField
            icon={<ClockIcon aria-hidden="true" />}
            label="Qualified"
            value={formatDateTime(attribution.timeline.qualifiedAt)}
          />
          <AttributionField
            label="First booked"
            value={formatDateTime(attribution.timeline.firstBookedAt)}
          />
          <AttributionField
            label="First meeting"
            value={formatDateTime(attribution.timeline.firstMeetingAt)}
          />
          <AttributionField
            label="Payment received"
            value={formatDateTime(attribution.timeline.paymentReceivedAt)}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function AttributionField({
  icon,
  label,
  value,
}: {
  icon?: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {icon ? <span className="[&>svg]:size-3">{icon}</span> : null}
        {label}
      </p>
      <p className="truncate text-sm font-medium" title={value}>
        {value}
      </p>
    </div>
  );
}
