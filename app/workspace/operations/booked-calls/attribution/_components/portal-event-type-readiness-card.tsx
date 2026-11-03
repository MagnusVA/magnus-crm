"use client";

import { useDeferredValue, useState } from "react";
import Link from "next/link";
import { useMutation } from "convex/react";
import { ArrowUpRightIcon, SearchIcon, TriangleAlertIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DetailCard,
  DetailCardFooter,
} from "@/app/workspace/closer/meetings/_components/detail-card";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tabs as TabsPrimitive } from "radix-ui";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  READINESS_LABEL,
  type PortalReadiness,
  portalReadinessFor,
} from "@/app/workspace/_components/portal-readiness";
import { getErrorMessage } from "@/lib/errors";
import { SCHEDULING_MODE_LABEL } from "@/lib/scheduling-mode";
import { cn } from "@/lib/utils";
import {
  CardNote,
  RuledTable,
  SEGMENT_ITEM,
  SEGMENT_TRACK,
  StatusWord,
  TableSkeleton,
  Td,
  Th,
  Tr,
} from "./attribution-ui";

const TITLE = "Portal event types";
const HEADS = ["Event type", "Program", "Type", "Status", "Visible"];

type EventTypeConfig = Doc<"eventTypeConfigs"> & {
  portalReadiness?: PortalReadiness;
};

const FILTERS = [
  { value: "published", label: "Published" },
  { value: "available", label: "Ready to publish" },
  { value: "unmapped", label: "Unmapped" },
  { value: "all", label: "All" },
] as const;
type Filter = (typeof FILTERS)[number]["value"];

const PAGE_SIZE = 25;

function isMapped(config: EventTypeConfig) {
  return (
    config.bookingProgramId !== undefined &&
    config.bookingProgramMappingStatus === "mapped"
  );
}

function filterOf(config: EventTypeConfig): Exclude<Filter, "all"> {
  if (config.linkPortalEnabled === true) {
    return "published";
  }
  return isMapped(config) ? "available" : "unmapped";
}

// Mirrors the checks in setLinkPortalEnabled so the switch can explain why
// publishing would fail instead of letting the mutation reject it.
function publishBlocker(config: EventTypeConfig): string | null {
  const isCalendlyBookable =
    config.calendlySyncStatus === undefined ||
    config.calendlySyncStatus === "active";
  if (!isCalendlyBookable) {
    return "Calendly no longer offers this event type.";
  }
  if (
    config.bookingUrlSource === "calendly_synced" &&
    !config.calendlySchedulingUrl
  ) {
    return "Sync a valid Calendly invite link before publishing.";
  }
  if (!config.bookingBaseUrl) {
    return "Add a booking URL before publishing.";
  }
  if (!isMapped(config)) {
    return "Map a booked program before publishing.";
  }
  return null;
}

function compareConfigs(a: EventTypeConfig, b: EventTypeConfig) {
  const programA = a.bookingProgramName ?? "￿";
  const programB = b.bookingProgramName ?? "￿";
  return (
    programA.localeCompare(programB) ||
    Number(a.isExtended === true) - Number(b.isExtended === true) ||
    a.displayName.localeCompare(b.displayName)
  );
}

function matchesSearch(config: EventTypeConfig, search: string) {
  if (!search) {
    return true;
  }
  return [config.displayName, config.bookingProgramName, config.bookingBaseUrl]
    .filter(Boolean)
    .some((value) => value!.toLowerCase().includes(search));
}

export function PortalEventTypeReadinessCard({
  eventTypeConfigs,
}: {
  eventTypeConfigs: EventTypeConfig[];
}) {
  const setLinkPortalEnabled = useMutation(
    api.eventTypeConfigs.mutations.setLinkPortalEnabled,
  );
  const [pendingConfigId, setPendingConfigId] =
    useState<Id<"eventTypeConfigs"> | null>(null);
  const [selectedFilter, setSelectedFilter] = useState<Filter | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const search = useDeferredValue(searchInput.trim().toLowerCase());
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const counts: Record<Filter, number> = {
    published: 0,
    available: 0,
    unmapped: 0,
    all: eventTypeConfigs.length,
  };
  for (const config of eventTypeConfigs) {
    counts[filterOf(config)] += 1;
  }
  const filter: Filter =
    selectedFilter ?? (counts.published > 0 ? "published" : "all");

  const brokenPublished = eventTypeConfigs.filter(
    (config) =>
      config.linkPortalEnabled === true &&
      (config.portalReadiness ?? portalReadinessFor(config)) !== "ready",
  );

  const rows = eventTypeConfigs
    .filter((config) => filter === "all" || filterOf(config) === filter)
    .filter((config) => matchesSearch(config, search))
    .sort(compareConfigs);
  const visibleRows = rows.slice(0, visibleCount);

  function handleFilterChange(value: string) {
    setSelectedFilter(value as Filter);
    setVisibleCount(PAGE_SIZE);
  }

  async function handleToggle(
    eventTypeConfigId: Id<"eventTypeConfigs">,
    linkPortalEnabled: boolean,
  ) {
    setPendingConfigId(eventTypeConfigId);
    try {
      await setLinkPortalEnabled({
        eventTypeConfigId,
        linkPortalEnabled,
      });
      toast.success(
        linkPortalEnabled
          ? "Event type published to portal"
          : "Event type hidden from portal",
      );
    } catch (error) {
      toast.error(
        getErrorMessage(error, "Could not update event type visibility"),
      );
    } finally {
      setPendingConfigId(null);
    }
  }

  return (
    <DetailCard
      title={TITLE}
      className="@container/types min-w-0"
      meta={
        <Button variant="outline" size="sm" asChild>
          <Link href="/workspace/settings">
            Map programs
            <ArrowUpRightIcon data-icon="inline-end" aria-hidden="true" />
          </Link>
        </Button>
      }
    >
      <CardNote>
        Event types DM closers can generate links for. Publishing needs a
        mapped program, a booking URL, and a bookable Calendly event type.
      </CardNote>

      {brokenPublished.length > 0 ? (
        <div className="border-b px-4 py-3">
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>
              {brokenPublished.length === 1
                ? "1 published event type can't be booked"
                : `${brokenPublished.length} published event types can't be booked`}
            </AlertTitle>
            <AlertDescription>
              {brokenPublished
                .map(
                  (config) =>
                    `${config.displayName} (${READINESS_LABEL[config.portalReadiness ?? portalReadinessFor(config)].toLowerCase()})`,
                )
                .join(", ")}
            </AlertDescription>
          </Alert>
        </div>
      ) : null}

      <div className="flex flex-col gap-2.5 px-4 py-2.5 @xl/types:flex-row @xl/types:items-center @xl/types:justify-between">
        <TabsPrimitive.Root value={filter} onValueChange={handleFilterChange} className="min-w-0">
          <TabsPrimitive.List aria-label="Which event types" className={SEGMENT_TRACK}>
            {FILTERS.map(({ value, label }) => (
              <TabsPrimitive.Trigger key={value} value={value} className={SEGMENT_ITEM}>
                {label}
                <span className="font-condensed text-[13px] font-semibold tabular-nums">
                  {counts[value]}
                </span>
              </TabsPrimitive.Trigger>
            ))}
          </TabsPrimitive.List>
        </TabsPrimitive.Root>
        <InputGroup className="h-[30px] @xl/types:w-60">
          <InputGroupInput
            type="search"
            value={searchInput}
            placeholder="Search event types"
            aria-label="Search event types"
            className="text-[13px]"
            onChange={(event) => {
              setSearchInput(event.target.value);
              setVisibleCount(PAGE_SIZE);
            }}
          />
          <InputGroupAddon>
            <SearchIcon aria-hidden="true" />
          </InputGroupAddon>
        </InputGroup>
      </div>

      {visibleRows.length === 0 ? (
        <SectionEmpty
          className="border-t"
          title={search ? "No event types match your search." : emptyMessage(filter)}
        />
      ) : (
        <RuledTable label={TITLE} className="min-w-[40rem] table-fixed">
          <thead>
            <tr>
              <Th>Event type</Th>
              <Th className="w-44">Program</Th>
              <Th className="w-24">Type</Th>
              <Th className="w-44">Status</Th>
              <Th className="w-20 text-right">Visible</Th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((config) => (
              <EventTypeRow
                key={config._id}
                config={config}
                isPending={pendingConfigId === config._id}
                onToggle={(linkPortalEnabled) =>
                  handleToggle(config._id, linkPortalEnabled)
                }
              />
            ))}
          </tbody>
        </RuledTable>
      )}

      {rows.length > PAGE_SIZE ? (
        <DetailCardFooter className="text-[13px] font-normal">
          <span>
            Showing{" "}
            <span className="font-condensed text-[15px] font-semibold text-foreground tabular-nums">
              {visibleRows.length}
            </span>{" "}
            of{" "}
            <span className="font-condensed text-[15px] font-semibold text-foreground tabular-nums">
              {rows.length}
            </span>
          </span>
          {visibleRows.length < rows.length ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
            >
              Show more
            </Button>
          ) : null}
        </DetailCardFooter>
      ) : null}
    </DetailCard>
  );
}

function emptyMessage(filter: Filter) {
  switch (filter) {
    case "published":
      return "No event types are published yet. Publish one from Ready to publish.";
    case "available":
      return "Every mapped event type is already published.";
    case "unmapped":
      return "Every event type is mapped to a program.";
    case "all":
      return "No event type configurations are available.";
  }
}

function EventTypeRow({
  config,
  isPending,
  onToggle,
}: {
  config: EventTypeConfig;
  isPending: boolean;
  onToggle: (linkPortalEnabled: boolean) => void;
}) {
  const isPublished = config.linkPortalEnabled === true;
  const readiness = config.portalReadiness ?? portalReadinessFor(config);
  const blocker = isPublished ? null : publishBlocker(config);

  const toggle = (
    <Switch
      checked={isPublished}
      disabled={isPending || blocker !== null}
      aria-label={`Toggle ${config.displayName} portal visibility`}
      onCheckedChange={onToggle}
    />
  );

  return (
    <Tr className={isPublished ? undefined : "text-muted-foreground"}>
      <Td>
        <div
          className={cn("truncate text-foreground", isPublished && "font-medium")}
          title={config.displayName}
        >
          {config.displayName}
        </div>
        <div
          className="truncate font-mono text-[13px] text-muted-foreground"
          title={config.bookingBaseUrl}
          translate="no"
        >
          {config.bookingBaseUrl?.replace(/^https?:\/\//, "") ?? "No booking URL"}
        </div>
      </Td>
      <Td>
        {config.bookingProgramName ? (
          <span
            className="block truncate text-foreground"
            title={config.bookingProgramName}
          >
            {config.bookingProgramName}
          </span>
        ) : (
          <span>Unmapped</span>
        )}
      </Td>
      <Td className="text-[13px]">
        {config.isExtended
          ? SCHEDULING_MODE_LABEL.extended
          : SCHEDULING_MODE_LABEL.normal}
      </Td>
      <Td>
        <PortalStatus isPublished={isPublished} readiness={readiness} />
      </Td>
      <Td>
        <div className="flex items-center justify-end gap-2">
          {isPending ? <Spinner /> : null}
          {blocker ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0} className="inline-flex rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {toggle}
                </span>
              </TooltipTrigger>
              <TooltipContent side="left">{blocker}</TooltipContent>
            </Tooltip>
          ) : (
            toggle
          )}
        </div>
      </Td>
    </Tr>
  );
}

function PortalStatus({
  isPublished,
  readiness,
}: {
  isPublished: boolean;
  readiness: PortalReadiness;
}) {
  if (isPublished && readiness === "ready") {
    return <StatusWord tone="active">Live</StatusWord>;
  }
  if (isPublished) {
    return <StatusWord tone="broken">{READINESS_LABEL[readiness]}</StatusWord>;
  }
  // Unpublished rows: only flag problems on mapped event types, since the
  // program column already says when one is unmapped.
  if (readiness === "missing_url" || readiness === "missing_current_calendly_url") {
    return <StatusWord tone="attention">{READINESS_LABEL[readiness]}</StatusWord>;
  }
  return <StatusWord tone="inactive">Hidden</StatusWord>;
}

export function PortalEventTypeReadinessSkeleton() {
  return (
    <DetailCard title={TITLE} className="min-w-0">
      <div className="flex items-center gap-2.5 border-b px-4 py-2.5">
        <Skeleton className="h-[30px] w-80 max-w-full" />
      </div>
      <TableSkeleton label="Loading portal event types" heads={HEADS} rows={6} rowClassName="h-[52px]" />
    </DetailCard>
  );
}
