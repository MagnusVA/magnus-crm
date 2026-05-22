"use client";

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import type { Id } from "@/convex/_generated/dataModel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatCalendlyLastRefresh } from "@/lib/calendly-connection-status";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import {
  CalendarIcon,
  Edit2Icon,
  ExternalLinkIcon,
  SearchIcon,
} from "lucide-react";
import {
  READINESS_LABEL,
  type PortalReadiness,
  portalReadinessFor,
  readinessBadgeVariant,
} from "./portal-readiness";

// Lazy-load dialog component that is only shown on user interaction
const EventTypeConfigDialog = dynamic(() =>
  import("./event-type-config-dialog").then((m) => ({
    default: m.EventTypeConfigDialog,
  })),
);

interface PaymentLink {
  provider: string;
  label: string;
  url: string;
}

interface EventTypeConfig {
  _id: string;
  calendlyEventTypeUri: string;
  displayName: string;
  calendlyName?: string;
  calendlySchedulingUrl?: string;
  calendlySyncStatus?: "active" | "inactive" | "deleted" | "not_returned";
  lastCalendlySyncedAt?: number;
  paymentLinks?: PaymentLink[];
  bookingProgramId?: Id<"tenantPrograms">;
  bookingProgramName?: string;
  bookingProgramMappingStatus?: "mapped" | "unmapped";
  bookingBaseUrl?: string;
  bookingUrlSource?: "admin_entered" | "imported_sheet" | "calendly_synced";
  linkPortalEnabled?: boolean;
  isExtended?: boolean;
  portalReadiness?: PortalReadiness;
}

const SYNC_STATUS_LABEL: Record<
  NonNullable<EventTypeConfig["calendlySyncStatus"]>,
  string
> = {
  active: "Active",
  inactive: "Inactive",
  deleted: "Deleted",
  not_returned: "Not returned",
};

const BOOKING_URL_SOURCE_LABEL: Record<
  NonNullable<EventTypeConfig["bookingUrlSource"]>,
  string
> = {
  admin_entered: "Admin URL",
  imported_sheet: "Imported URL",
  calendly_synced: "Calendly URL",
};

interface EventTypeConfigListProps {
  configs: EventTypeConfig[];
  onSuccess?: () => void;
}

export function EventTypeConfigList({
  configs,
  onSuccess,
}: EventTypeConfigListProps) {
  const [selectedConfig, setSelectedConfig] =
    useState<EventTypeConfig | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [now] = useState(() => Date.now());

  const handleEdit = (config: EventTypeConfig) => {
    setSelectedConfig(config);
    setDialogOpen(true);
  };

  const handleSuccess = () => {
    setDialogOpen(false);
    setSelectedConfig(null);
    onSuccess?.();
  };
  const filteredConfigs = useMemo(() => {
    const query = search.trim().toLowerCase();

    if (!query) {
      return configs;
    }

    return configs.filter((config) => {
      const searchable = [
        config.displayName,
        config.calendlyName,
        config.calendlySchedulingUrl,
        config.bookingProgramName,
        config.bookingBaseUrl,
        config.paymentLinks
          ?.map((link) => `${link.provider} ${link.label}`)
          .join(" "),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return searchable.includes(query);
    });
  }, [configs, search]);

  if (configs.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CalendarIcon />
          </EmptyMedia>
          <EmptyTitle>No event types configured</EmptyTitle>
          <EmptyDescription>
            Sync Calendly event types to import zero-booking event types and
            keep metadata current.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <>
      <Card>
        <CardHeader className="gap-4 pb-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <CardTitle>Event Types</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                {filteredConfigs.length} of {configs.length} event types shown
              </p>
            </div>
            <div className="relative w-full lg:w-80">
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search event types..."
                className="pl-9"
                aria-label="Search event types"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {filteredConfigs.length === 0 ? (
            <div className="border-t px-6 py-10 text-center text-sm text-muted-foreground">
              No event types match your search.
            </div>
          ) : (
            <div className="max-h-[min(68vh,720px)] overflow-auto border-t">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-card shadow-[0_1px_0_hsl(var(--border))]">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="min-w-72 pl-4">Event Type</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="min-w-56">Booked Program</TableHead>
                    <TableHead>Payment Links</TableHead>
                    <TableHead>Last Synced</TableHead>
                    <TableHead className="w-20 pr-4 text-right">Edit</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredConfigs.map((config) => {
                    const readiness =
                      config.portalReadiness ?? portalReadinessFor(config);
                    const paymentLinks = config.paymentLinks ?? [];

                    return (
                      <TableRow key={config._id}>
                        <TableCell className="max-w-96 pl-4">
                          <div className="min-w-0">
                            <div className="flex min-w-0 items-center gap-2">
                              <p className="truncate font-medium">
                                {config.displayName}
                              </p>
                              {config.calendlySchedulingUrl ? (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button
                                      variant="ghost"
                                      size="icon-xs"
                                      asChild
                                      aria-label={`Open ${config.displayName} Calendly link`}
                                    >
                                      <a
                                        href={config.calendlySchedulingUrl}
                                        target="_blank"
                                        rel="noreferrer"
                                      >
                                        <ExternalLinkIcon />
                                      </a>
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    Open Calendly link
                                  </TooltipContent>
                                </Tooltip>
                              ) : null}
                            </div>
                            {config.calendlyName &&
                            config.calendlyName !== config.displayName ? (
                              <p className="mt-1 truncate text-xs text-muted-foreground">
                                Calendly: {config.calendlyName}
                              </p>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col items-start gap-1.5">
                            <Badge
                              variant={
                                config.calendlySyncStatus === "deleted" ||
                                config.calendlySyncStatus === "inactive" ||
                                config.calendlySyncStatus === "not_returned"
                                  ? "destructive"
                                  : "outline"
                              }
                            >
                              {config.calendlySyncStatus
                                ? SYNC_STATUS_LABEL[config.calendlySyncStatus]
                                : "Legacy"}
                            </Badge>
                            <Badge variant={readinessBadgeVariant(readiness)}>
                              {READINESS_LABEL[readiness]}
                            </Badge>
                            {config.isExtended ? (
                              <Badge variant="secondary">Extended</Badge>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell className="max-w-72">
                          <div className="flex min-w-0 flex-col items-start gap-1.5">
                            <Badge
                              variant={
                                config.bookingProgramMappingStatus === "mapped"
                                  ? "secondary"
                                  : "outline"
                              }
                            >
                              {config.bookingProgramName ?? "Unmapped"}
                            </Badge>
                            <div className="flex min-w-0 max-w-full items-center gap-1.5">
                              {config.bookingUrlSource ? (
                                <Badge variant="muted">
                                  {BOOKING_URL_SOURCE_LABEL[
                                    config.bookingUrlSource
                                  ]}
                                </Badge>
                              ) : null}
                              {config.bookingBaseUrl ? (
                                <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                                  {config.bookingBaseUrl}
                                </span>
                              ) : null}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          {paymentLinks.length > 0 ? (
                            <div className="flex max-w-48 flex-wrap gap-1.5">
                              {paymentLinks.slice(0, 3).map((link) => (
                                <Badge
                                  key={`${link.provider}-${link.label}`}
                                  variant="secondary"
                                >
                                  {link.provider}
                                </Badge>
                              ))}
                              {paymentLinks.length > 3 ? (
                                <Badge variant="outline">
                                  +{paymentLinks.length - 3}
                                </Badge>
                              ) : null}
                            </div>
                          ) : (
                            <span className="text-sm text-muted-foreground">
                              None
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {config.lastCalendlySyncedAt
                            ? formatCalendlyLastRefresh(
                                config.lastCalendlySyncedAt,
                                now,
                              )
                            : "Never"}
                        </TableCell>
                        <TableCell className="pr-4 text-right">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                onClick={() => handleEdit(config)}
                                aria-label={`Edit ${config.displayName} configuration`}
                              >
                                <Edit2Icon />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Edit configuration</TooltipContent>
                          </Tooltip>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {selectedConfig && (
        <EventTypeConfigDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          config={selectedConfig}
          onSuccess={handleSuccess}
        />
      )}
    </>
  );
}
