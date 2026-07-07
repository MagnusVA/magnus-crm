"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { PencilIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { MemberIdentity } from "@/app/workspace/_components/member-identity";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
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
import { formatAmountMinor } from "@/lib/format-currency";
import { AttributionTeamDialog } from "./attribution-team-dialog";
import { AttributionUnmappedPanel } from "./attribution-unmapped-panel";
import { BookingLinkMatrix } from "./booking-link-matrix";
import { CampaignPresetsCard } from "./campaign-presets-card";
import { DmCloserDialog } from "./dm-closer-dialog";
import { PortalAccessCard } from "./portal-access-card";
import { PortalEventTypeReadinessCard } from "./portal-event-type-readiness-card";
import { PortalUsageCard } from "./portal-usage-card";

type DialogState =
  | { kind: "team"; teamId?: Id<"attributionTeams"> }
  | { kind: "dmCloser"; dmCloserId?: Id<"dmClosers"> }
  | null;

// Mirror the server-side bounds in convex/attribution/{teams,dmClosers}.ts.
const MAX_BOOKING_DAILY_QUOTA = 5000;
const MAX_HOURLY_RATE_MAJOR = 100_000;

/**
 * Inline click-to-edit numeric cell for the registry tables (booking goal per
 * day, hourly contract rate). Enter or blur commits, Escape cancels; `parse`
 * returns `undefined` for invalid input, `null` to clear the field.
 */
function InlineNumberCell({
  display,
  editValue,
  ariaLabel,
  invalidMessage,
  parse,
  onSave,
}: {
  display: string;
  editValue: string;
  ariaLabel: string;
  invalidMessage: string;
  parse: (raw: string) => number | null | undefined;
  onSave: (next: number | null) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const commit = async () => {
    const parsed = parse(draft);
    if (parsed === undefined) {
      toast.error(invalidMessage);
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onSave(parsed);
      setEditing(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to save value.",
      );
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <Input
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setEditing(false);
          }
        }}
        inputMode="decimal"
        disabled={saving}
        aria-label={ariaLabel}
        className="h-8 w-24"
      />
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="group/inline-edit -ml-2 h-8 gap-1.5 px-2 font-normal tabular-nums"
          aria-label={ariaLabel}
          onClick={() => {
            setDraft(editValue);
            setEditing(true);
          }}
        >
          <span className={display === "—" ? "text-muted-foreground" : ""}>
            {display}
          </span>
          <PencilIcon
            aria-hidden="true"
            className="size-3 text-muted-foreground opacity-0 transition-opacity group-hover/inline-edit:opacity-100 group-focus-visible/inline-edit:opacity-100"
          />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Click to edit</TooltipContent>
    </Tooltip>
  );
}

function parseDailyQuota(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return null;
  }
  const numeric = Number(trimmed);
  return Number.isInteger(numeric) &&
    numeric >= 0 &&
    numeric <= MAX_BOOKING_DAILY_QUOTA
    ? numeric
    : undefined;
}

function parseHourlyRateMajor(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return null;
  }
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) &&
    numeric >= 0 &&
    numeric <= MAX_HOURLY_RATE_MAJOR
    ? Math.round(numeric * 100)
    : undefined;
}

export function AttributionTab() {
  const [dialog, setDialog] = useState<DialogState>(null);
  const teams = useQuery(api.attribution.teams.listTeams, {});
  const closers = useQuery(api.attribution.dmClosers.listDmClosers, {});
  const teamMembers = useQuery(api.users.queries.listTeamMembers, {});
  const eventTypeConfigs = useQuery(
    api.eventTypeConfigs.queries.listEventTypeConfigs,
    {},
  );
  const setTeamActive = useMutation(api.attribution.teams.setTeamActive);
  const setDmCloserActive = useMutation(
    api.attribution.dmClosers.setDmCloserActive,
  );
  const setTeamBookingQuota = useMutation(
    api.attribution.teams.setTeamBookingQuota,
  );
  const setDmCloserHourlyRate = useMutation(
    api.attribution.dmClosers.setDmCloserHourlyRate,
  );

  const selectedTeam = useMemo(
    () =>
      dialog?.kind === "team" && dialog.teamId
        ? teams?.find((team) => team._id === dialog.teamId)
        : undefined,
    [dialog, teams],
  );
  const selectedDmCloser = useMemo(
    () =>
      dialog?.kind === "dmCloser" && dialog.dmCloserId
        ? closers?.find((closer) => closer._id === dialog.dmCloserId)
        : undefined,
    [closers, dialog],
  );

  const registryLoaded = teams !== undefined && closers !== undefined;
  const matrixLoaded =
    teams !== undefined &&
    closers !== undefined &&
    eventTypeConfigs !== undefined;

  return (
    <div className="flex flex-col gap-4">
      <PortalAccessCard />
      <PortalUsageCard />

      <Alert>
        <AlertTitle>External DM attribution</AlertTitle>
        <AlertDescription>
          DM teams and DM closers normalize Calendly UTM values only. They do
          not create CRM accounts or WorkOS users.
        </AlertDescription>
      </Alert>

      {registryLoaded ? (
        <>
          <div className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-base">DM Teams</CardTitle>
                <Button size="sm" onClick={() => setDialog({ kind: "team" })}>
                  New Team
                </Button>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>UTM Source</TableHead>
                      <TableHead>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="cursor-default">Goal/day</span>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs text-pretty">
                            Booked-calls goal per business day. The Booked
                            Calls goal ring multiplies it by the business days
                            in the selected range.
                          </TooltipContent>
                        </Tooltip>
                      </TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {teams.map((team) => (
                      <TableRow key={team._id}>
                        <TableCell>{team.displayName}</TableCell>
                        <TableCell className="font-mono text-xs">
                          {team.utmSource}
                        </TableCell>
                        <TableCell>
                          <InlineNumberCell
                            display={
                              team.bookingDailyQuota === undefined
                                ? "—"
                                : String(team.bookingDailyQuota)
                            }
                            editValue={
                              team.bookingDailyQuota === undefined
                                ? ""
                                : String(team.bookingDailyQuota)
                            }
                            ariaLabel={`Daily booking goal for ${team.displayName}`}
                            invalidMessage={`Enter a whole number from 0 to ${MAX_BOOKING_DAILY_QUOTA}, or leave blank to clear.`}
                            parse={parseDailyQuota}
                            onSave={(next) =>
                              setTeamBookingQuota({
                                teamId: team._id,
                                bookingDailyQuota: next,
                              })
                            }
                          />
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={team.isActive ? "secondary" : "outline"}
                          >
                            {team.isActive ? "Active" : "Disabled"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                setDialog({ kind: "team", teamId: team._id })
                              }
                            >
                              Edit
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                setTeamActive({
                                  teamId: team._id,
                                  isActive: !team.isActive,
                                })
                              }
                            >
                              {team.isActive ? "Disable" : "Enable"}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-base">DM Closers</CardTitle>
                <Button
                  size="sm"
                  onClick={() => setDialog({ kind: "dmCloser" })}
                  disabled={teams.length === 0}
                >
                  New DM Closer
                </Button>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Team</TableHead>
                      <TableHead>UTM Medium</TableHead>
                      <TableHead>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="cursor-default">Rate/hr</span>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs text-pretty">
                            Hourly contract rate. Enter it in major units
                            (e.g. 25 for $25.00/hr); it is stored in cents.
                          </TooltipContent>
                        </Tooltip>
                      </TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {closers.map((closer) => (
                      <TableRow key={closer._id}>
                        <TableCell>
                          <MemberIdentity identity={closer.identity} />
                        </TableCell>
                        <TableCell>{closer.teamLabel}</TableCell>
                        <TableCell className="font-mono text-xs">
                          {closer.utmMedium}
                        </TableCell>
                        <TableCell>
                          <InlineNumberCell
                            display={
                              closer.hourlyRateMinor === undefined
                                ? "—"
                                : `${formatAmountMinor(
                                    closer.hourlyRateMinor,
                                    "USD",
                                  )}/hr`
                            }
                            editValue={
                              closer.hourlyRateMinor === undefined
                                ? ""
                                : String(closer.hourlyRateMinor / 100)
                            }
                            ariaLabel={`Hourly rate for ${closer.displayName}`}
                            invalidMessage={`Enter an amount from 0 to ${MAX_HOURLY_RATE_MAJOR}, or leave blank to clear.`}
                            parse={parseHourlyRateMajor}
                            onSave={(next) =>
                              setDmCloserHourlyRate({
                                dmCloserId: closer._id,
                                hourlyRateMinor: next,
                              })
                            }
                          />
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              closer.isActive ? "secondary" : "outline"
                            }
                          >
                            {closer.isActive ? "Active" : "Disabled"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                setDialog({
                                  kind: "dmCloser",
                                  dmCloserId: closer._id,
                                })
                              }
                            >
                              Edit
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                setDmCloserActive({
                                  dmCloserId: closer._id,
                                  isActive: !closer.isActive,
                                })
                              }
                            >
                              {closer.isActive ? "Disable" : "Enable"}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>

          <AttributionTeamDialog
            open={dialog?.kind === "team"}
            onOpenChange={(open) => !open && setDialog(null)}
            team={selectedTeam}
          />
          <DmCloserDialog
            open={dialog?.kind === "dmCloser"}
            onOpenChange={(open) => !open && setDialog(null)}
            dmCloser={selectedDmCloser}
            teams={teams}
            teamMembers={teamMembers ?? []}
          />
        </>
      ) : (
        <AttributionRegistrySkeleton />
      )}

      <CampaignPresetsCard />

      {eventTypeConfigs === undefined ? (
        <Skeleton className="h-72 w-full" />
      ) : (
        <PortalEventTypeReadinessCard eventTypeConfigs={eventTypeConfigs} />
      )}

      <AttributionUnmappedPanel />

      {matrixLoaded ? (
        <BookingLinkMatrix
          teams={teams}
          closers={closers}
          eventTypeConfigs={eventTypeConfigs}
        />
      ) : (
        <Skeleton className="h-80 w-full" />
      )}
    </div>
  );
}

function AttributionRegistrySkeleton() {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Skeleton className="h-72 w-full" />
      <Skeleton className="h-72 w-full" />
    </div>
  );
}
