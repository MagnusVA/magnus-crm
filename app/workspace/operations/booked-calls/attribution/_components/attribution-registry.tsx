"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { PencilIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { MemberIdentity } from "@/app/workspace/_components/member-identity";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatAmountMinor } from "@/lib/format-currency";
import { DetailCard } from "@/app/workspace/closer/meetings/_components/detail-card";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { AttributionTeamDialog } from "./attribution-team-dialog";
import { DmClosersCardSkeleton, DmTeamsCardSkeleton } from "./attribution-registry-skeleton";
import { CardNote, CODE, RuledTable, StatusWord, Td, Th, Tr } from "./attribution-ui";
import { DmCloserDialog } from "./dm-closer-dialog";
import { getErrorMessage } from "@/lib/errors";

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
        getErrorMessage(error, "Failed to save value."),
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
        className="h-8 w-24 font-condensed text-[15px] tabular-nums"
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
          className="group/inline-edit -ml-2 h-8 gap-1.5 px-2 font-condensed text-[15px] font-semibold tabular-nums"
          aria-label={ariaLabel}
          onClick={() => {
            setDraft(editValue);
            setEditing(true);
          }}
        >
          <span className={display === "—" ? "font-normal text-muted-foreground" : ""}>
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

export function AttributionRegistry() {
  const [dialog, setDialog] = useState<DialogState>(null);
  const teams = useQuery(api.attribution.teams.listTeams, {});
  const closers = useQuery(api.attribution.dmClosers.listDmClosers, {});
  const teamMembers = useQuery(api.users.queries.listTeamMembers, {});
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

  return (
    <div className="flex flex-col gap-3.5 short:gap-3">
      <Alert>
        <AlertTitle>External DM attribution</AlertTitle>
        <AlertDescription>
          DM teams and DM closers normalize Calendly UTM values only. They do
          not create CRM accounts or WorkOS users.
        </AlertDescription>
      </Alert>

      {registryLoaded ? (
        <>
          <div className="grid gap-3.5 short:gap-3 @6xl:grid-cols-[0.9fr_1.1fr] @6xl:items-start">
            <DetailCard
              title="DM teams"
              className="min-w-0"
              meta={
                <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "team" })}>
                  New DM team
                </Button>
              }
            >
              <CardNote>
                Goal / day is the booked-calls goal per business day. Booked
                calls multiplies it by the business days in the chosen range.
              </CardNote>
              {teams.length === 0 ? (
                <SectionEmpty title="No DM teams yet.">
                  A DM team maps one UTM source to an external team.
                </SectionEmpty>
              ) : (
                <RuledTable label="DM teams">
                  <thead>
                    <tr>
                      <Th>Name</Th>
                      <Th>UTM source</Th>
                      <Th>Goal / day</Th>
                      <Th>Status</Th>
                      <Th>
                        <span className="sr-only">Actions</span>
                      </Th>
                    </tr>
                  </thead>
                  <tbody>
                    {teams.map((team) => (
                      <Tr key={team._id}>
                        <Td className="font-medium">{team.displayName}</Td>
                        <Td className={CODE} translate="no">
                          {team.utmSource}
                        </Td>
                        <Td>
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
                        </Td>
                        <Td>
                          <StatusWord tone={team.isActive ? "active" : "inactive"}>
                            {team.isActive ? "Active" : "Disabled"}
                          </StatusWord>
                        </Td>
                        <Td className="text-right">
                          <div className="flex justify-end gap-1.5">
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label={`Edit ${team.displayName}`}
                              onClick={() =>
                                setDialog({ kind: "team", teamId: team._id })
                              }
                            >
                              Edit
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              aria-label={`${team.isActive ? "Disable" : "Enable"} ${team.displayName}`}
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
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </RuledTable>
              )}
            </DetailCard>

            <DetailCard
              title="DM closers"
              className="min-w-0"
              meta={
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setDialog({ kind: "dmCloser" })}
                  disabled={teams.length === 0}
                >
                  New DM closer
                </Button>
              }
            >
              <CardNote>
                Rate / h is the hourly contract rate. Enter it in dollars (25
                for $25.00 an hour); it is stored in cents.
              </CardNote>
              {closers.length === 0 ? (
                <SectionEmpty title="No DM closers yet.">
                  {teams.length === 0
                    ? "Add a DM team first, then its DM closers."
                    : "A DM closer maps one UTM medium to a person on a DM team."}
                </SectionEmpty>
              ) : (
                <RuledTable label="DM closers">
                  <thead>
                    <tr>
                      <Th>DM closer</Th>
                      <Th>Team</Th>
                      <Th>UTM medium</Th>
                      <Th>Rate / h</Th>
                      <Th>Status</Th>
                      <Th>
                        <span className="sr-only">Actions</span>
                      </Th>
                    </tr>
                  </thead>
                  <tbody>
                    {closers.map((closer) => (
                      <Tr key={closer._id}>
                        <Td>
                          <MemberIdentity identity={closer.identity} />
                        </Td>
                        <Td>{closer.teamLabel}</Td>
                        <Td className={CODE} translate="no">
                          {closer.utmMedium}
                        </Td>
                        <Td>
                          <InlineNumberCell
                            display={
                              closer.hourlyRateMinor === undefined
                                ? "—"
                                : `${formatAmountMinor(
                                    closer.hourlyRateMinor,
                                    "USD",
                                  )}/h`
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
                        </Td>
                        <Td>
                          <StatusWord tone={closer.isActive ? "active" : "inactive"}>
                            {closer.isActive ? "Active" : "Disabled"}
                          </StatusWord>
                        </Td>
                        <Td className="text-right">
                          <div className="flex justify-end gap-1.5">
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label={`Edit ${closer.displayName}`}
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
                              aria-label={`${closer.isActive ? "Disable" : "Enable"} ${closer.displayName}`}
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
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </RuledTable>
              )}
            </DetailCard>
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
        <div className="grid gap-3.5 short:gap-3 @6xl:grid-cols-[0.9fr_1.1fr] @6xl:items-start">
          <DmTeamsCardSkeleton />
          <DmClosersCardSkeleton />
        </div>
      )}
    </div>
  );
}
