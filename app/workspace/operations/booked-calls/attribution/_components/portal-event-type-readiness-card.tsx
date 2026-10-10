"use client";

import { useDeferredValue, useState } from "react";
import Link from "next/link";
import { useMutation } from "convex/react";
import { ArrowUpRightIcon, SearchIcon, TriangleAlertIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
    <Card>
      <CardHeader>
        <CardTitle>Portal Event Types</CardTitle>
        <CardDescription>
          Event types DM closers can generate links for. Publishing needs a
          mapped program, a booking URL, and a bookable Calendly event type.
        </CardDescription>
        <CardAction>
          <Button variant="ghost" size="sm" asChild>
            <Link href="/workspace/settings">
              Map programs
              <ArrowUpRightIcon data-icon="inline-end" aria-hidden="true" />
            </Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {brokenPublished.length > 0 ? (
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
        ) : null}

        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <Tabs value={filter} onValueChange={handleFilterChange}>
            <TabsList className="max-w-full overflow-x-auto">
              {FILTERS.map(({ value, label }) => (
                <TabsTrigger key={value} value={value} className="px-2.5">
                  {label}
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {counts[value]}
                  </span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <InputGroup className="lg:w-64">
            <InputGroupInput
              type="search"
              value={searchInput}
              placeholder="Search event types"
              aria-label="Search event types"
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

        <div className="overflow-hidden rounded-lg border">
          <Table className="table-fixed">
            <TableHeader className="bg-muted/40">
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-3">Event Type</TableHead>
                <TableHead className="w-44">Program</TableHead>
                <TableHead className="w-24">Type</TableHead>
                <TableHead className="w-40">Status</TableHead>
                <TableHead className="w-20 pr-3 text-right">Visible</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleRows.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell
                    colSpan={5}
                    className="h-24 text-center whitespace-normal text-muted-foreground"
                  >
                    {search
                      ? "No event types match your search."
                      : emptyMessage(filter)}
                  </TableCell>
                </TableRow>
              ) : null}
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
            </TableBody>
          </Table>
        </div>

        {rows.length > PAGE_SIZE ? (
          <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span className="tabular-nums">
              Showing {visibleRows.length} of {rows.length}
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
          </div>
        ) : null}
      </CardContent>
    </Card>
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
    <TableRow className={isPublished ? undefined : "text-muted-foreground"}>
      <TableCell className="pl-3">
        <div
          className={
            isPublished
              ? "truncate font-medium text-foreground"
              : "truncate text-foreground"
          }
          title={config.displayName}
        >
          {config.displayName}
        </div>
        <div
          className="truncate font-mono text-xs text-muted-foreground"
          title={config.bookingBaseUrl}
          translate="no"
        >
          {config.bookingBaseUrl?.replace(/^https?:\/\//, "") ?? "No booking URL"}
        </div>
      </TableCell>
      <TableCell>
        {config.bookingProgramName ? (
          <span
            className="block truncate text-foreground"
            title={config.bookingProgramName}
          >
            {config.bookingProgramName}
          </span>
        ) : (
          <span className="italic">Unmapped</span>
        )}
      </TableCell>
      <TableCell>
        <Badge variant={config.isExtended ? "secondary" : "outline"}>
          {config.isExtended
            ? SCHEDULING_MODE_LABEL.extended
            : SCHEDULING_MODE_LABEL.normal}
        </Badge>
      </TableCell>
      <TableCell>
        <StatusBadge isPublished={isPublished} readiness={readiness} />
      </TableCell>
      <TableCell className="pr-3">
        <div className="flex items-center justify-end gap-2">
          {isPending ? <Spinner /> : null}
          {blocker ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0} className="inline-flex rounded-full">
                  {toggle}
                </span>
              </TooltipTrigger>
              <TooltipContent side="left">{blocker}</TooltipContent>
            </Tooltip>
          ) : (
            toggle
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

function StatusBadge({
  isPublished,
  readiness,
}: {
  isPublished: boolean;
  readiness: PortalReadiness;
}) {
  if (isPublished && readiness === "ready") {
    return (
      <Badge variant="secondary">
        <span
          className="size-1.5 rounded-full bg-emerald-500"
          aria-hidden="true"
        />
        Live
      </Badge>
    );
  }
  if (isPublished) {
    return (
      <Badge variant="destructive" className="max-w-full truncate">
        {READINESS_LABEL[readiness]}
      </Badge>
    );
  }
  // Unpublished rows: only flag problems on mapped event types, since the
  // program column already says when one is unmapped.
  if (readiness === "missing_url" || readiness === "missing_current_calendly_url") {
    return (
      <Badge variant="destructive" className="max-w-full truncate">
        {READINESS_LABEL[readiness]}
      </Badge>
    );
  }
  return <Badge variant="muted">Hidden</Badge>;
}
