"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EVENT_LABELS } from "@/convex/reporting/lib/eventLabels";

const ENTITY_TYPE_OPTIONS = [
  { label: "All", value: "__all__" },
  { label: "Customer", value: "customer" },
  { label: "Follow-Up", value: "followUp" },
  { label: "Lead", value: "lead" },
  { label: "Meeting", value: "meeting" },
  { label: "Opportunity", value: "opportunity" },
  { label: "Payment", value: "payment" },
  { label: "User", value: "user" },
] as const;

const EVENT_TYPE_OPTIONS = [
  { label: "All", value: "__all__" },
  ...Object.entries(EVENT_LABELS).map(([key, { verb }]) => ({
    label: verb.charAt(0).toUpperCase() + verb.slice(1),
    value: key,
  })),
];

type EntityType =
  | "customer"
  | "followUp"
  | "lead"
  | "meeting"
  | "opportunity"
  | "payment"
  | "user";

interface Filters {
  entityType?: EntityType;
  eventType?: string;
  actorUserId?: string;
}

interface ActivityFeedFiltersProps {
  filters: Filters;
  onChange: (filters: Filters) => void;
  actorBreakdown: Array<{
    actorUserId: string;
    actorName: string | null;
    count: number;
  }>;
}

export function ActivityFeedFilters({
  filters,
  onChange,
  actorBreakdown,
}: ActivityFeedFiltersProps) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      {/* Entity Type filter */}
      <Select
        value={filters.entityType ?? "__all__"}
        onValueChange={(value) => {
          const next = { ...filters };
          if (value === "__all__") {
            delete next.entityType;
          } else {
            next.entityType = value as EntityType;
          }
          onChange(next);
        }}
      >
        <SelectTrigger className="w-[160px]">
          <SelectValue placeholder="Entity Type" />
        </SelectTrigger>
        <SelectContent>
          {ENTITY_TYPE_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Event Type filter */}
      <Select
        value={filters.eventType ?? "__all__"}
        onValueChange={(value) => {
          const next = { ...filters };
          if (value === "__all__") {
            delete next.eventType;
          } else {
            next.eventType = value;
          }
          onChange(next);
        }}
      >
        <SelectTrigger className="w-[240px]">
          <SelectValue placeholder="Event Type" />
        </SelectTrigger>
        <SelectContent>
          {EVENT_TYPE_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Actor filter */}
      <Select
        value={filters.actorUserId ?? "__all__"}
        onValueChange={(value) => {
          const next = { ...filters };
          if (value === "__all__") {
            delete next.actorUserId;
          } else {
            next.actorUserId = value;
          }
          onChange(next);
        }}
      >
        <SelectTrigger className="w-[200px]">
          <SelectValue placeholder="Actor" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__">All</SelectItem>
          {actorBreakdown.map((actor) => (
            <SelectItem key={actor.actorUserId} value={actor.actorUserId}>
              {actor.actorName ?? "Unknown"} ({actor.count})
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
