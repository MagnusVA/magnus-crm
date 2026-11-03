"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { toast } from "sonner";
import posthog from "posthog-js";
import { ChevronRightIcon, PlusIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { buildBookingUrl } from "@/app/dm-links/[portalSlug]/_components/build-booking-url";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { getErrorMessage } from "@/lib/errors";
import { reportClientError } from "@/lib/observability/report-client-error";
import { cn } from "@/lib/utils";
import type { CoverageTeam } from "../booking-model";
import { GetsRows } from "./gets-table";
import { canBook, type TeamAccess } from "./team-access";
import { EMPTY_WEEK, formatHours, ScheduleBlock, weekTotal, type WeekHours } from "./schedule-editor";
import { ActiveWord, CardHead, CARD, Code, FIGURE, firstName, HelpTip, Initials, LABEL } from "./team-ui";
import { normalizeUtm } from "./utm-suggestions";

export type RosterDmCloser = FunctionReturnType<typeof api.attribution.dmClosers.listDmClosers>[number];
type TeamMember = FunctionReturnType<typeof api.users.queries.listTeamMembers>[number];
type UnmatchedGroup = FunctionReturnType<typeof api.bookingSetup.queries.getBookingActivity>["unmatchedUtms"][number];

const ROW =
  "grid w-full items-center gap-2.5 px-4 text-left grid-cols-[28px_minmax(0,1fr)_40px_72px_14px] @lg/roster:grid-cols-[28px_minmax(0,1.3fr)_minmax(0,1fr)_44px_52px_70px_14px]";

export function RosterCard({
  team,
  teams,
  closers,
  allClosers,
  bookings,
  teamMembers,
  access,
  campaign,
  unmatched,
  openId,
  scheduleOpen,
  schedules,
  onToggle,
  onScheduleChange,
  onNew,
}: {
  team: CoverageTeam;
  teams: readonly Doc<"attributionTeams">[];
  closers: readonly RosterDmCloser[];
  allClosers: readonly RosterDmCloser[];
  bookings: Record<string, number>;
  teamMembers: readonly TeamMember[];
  access: TeamAccess;
  campaign: { label: string; utmCampaign: string } | null;
  unmatched: readonly UnmatchedGroup[];
  openId: string | null;
  scheduleOpen: boolean;
  schedules: ReadonlyMap<string, WeekHours>;
  onToggle: (dmCloserId: string) => void;
  onScheduleChange: (dmCloserId: string, open: boolean) => void;
  onNew: () => void;
}) {
  const roster = [...closers].sort(
    (a, b) =>
      Number(b.isActive) - Number(a.isActive) ||
      (bookings[b._id] ?? 0) - (bookings[a._id] ?? 0) ||
      a.displayName.localeCompare(b.displayName),
  );

  return (
    <section className={cn(CARD, "@container/roster")} aria-labelledby="roster-title">
      <CardHead title={<span id="roster-title">Roster</span>} meta="Click a DM closer to edit them, set their schedule and see their links">
        <Button variant="outline" size="sm" onClick={onNew}>
          <PlusIcon aria-hidden="true" />
          New DM closer
        </Button>
      </CardHead>
      <div className={cn(ROW, "min-h-[34px] border-b border-border pt-2.5 pb-2")}>
        <span />
        <span className={LABEL}>
          <HelpTip tip="The external setter's name, and the CRM user they're linked to, if any. Click a row to edit them.">
            DM closer
          </HelpTip>
        </span>
        <span className={cn(LABEL, "hidden @lg/roster:block")}>
          <HelpTip tip="The value their links carry as utm_medium. A booking whose utm_medium matches it (and whose utm_source matches the team) is credited to this DM closer.">
            utm_medium
          </HelpTip>
        </span>
        <span className={cn(LABEL, "text-right")}>
          <HelpTip tip="Bookings made in the last 30 days through links with this DM closer's utm_medium.">30d</HelpTip>
        </span>
        <span className={cn(LABEL, "hidden text-right @lg/roster:block")}>
          <HelpTip tip="Hours scheduled a week. Booked Calls divides booked calls by these hours. Open a DM closer and use Set schedule to change them.">
            Hours
          </HelpTip>
        </span>
        <span className={LABEL}>
          <HelpTip tip="Active DM closers appear in the link portal and get credit for bookings. Disabled ones keep their history but can't copy links.">
            Status
          </HelpTip>
        </span>
        <span />
      </div>
      {roster.length === 0 ? (
        <p className="px-4 py-5 text-[14px] text-muted-foreground">
          No DM closers on {team.displayName} yet. Each one is a utm_medium; add the first with New DM closer.
        </p>
      ) : (
        <ul>
          {roster.map((closer) => (
            <CloserRow
              key={closer._id}
              closer={closer}
              team={team}
              teams={teams}
              allClosers={allClosers}
              booked={bookings[closer._id] ?? 0}
              teamMembers={teamMembers}
              access={access}
              campaign={campaign}
              unmatched={unmatched}
              open={openId === closer._id}
              week={schedules.get(closer._id) ?? EMPTY_WEEK}
              scheduleOpen={openId === closer._id && scheduleOpen}
              onToggle={() => onToggle(closer._id)}
              onScheduleChange={(next) => onScheduleChange(closer._id, next)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function CloserRow({
  closer,
  team,
  teams,
  allClosers,
  booked,
  teamMembers,
  access,
  campaign,
  unmatched,
  open,
  week,
  scheduleOpen,
  onToggle,
  onScheduleChange,
}: {
  closer: RosterDmCloser;
  team: CoverageTeam;
  teams: readonly Doc<"attributionTeams">[];
  allClosers: readonly RosterDmCloser[];
  booked: number;
  teamMembers: readonly TeamMember[];
  access: TeamAccess;
  campaign: { label: string; utmCampaign: string } | null;
  unmatched: readonly UnmatchedGroup[];
  open: boolean;
  week: WeekHours;
  scheduleOpen: boolean;
  onToggle: () => void;
  onScheduleChange: (open: boolean) => void;
}) {
  const weekly = weekTotal(week);
  const editorId = `closer-${closer._id}`;
  return (
    <li id={`row-${closer._id}`} className="scroll-mt-4 border-t border-border first:border-t-0">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-label={`Edit ${closer.displayName}`}
        onClick={onToggle}
        className={cn(ROW, "min-h-14 py-[9px] text-[14px] outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset")}
      >
        <Initials name={closer.displayName} />
        <span className="min-w-0">
          <b className="block truncate font-semibold">{closer.displayName}</b>
          <small className="block truncate text-[12px] text-muted-foreground">
            {closer.userId ? (closer.identity.email ?? "CRM user") : "No CRM user"}
          </small>
        </span>
        <span className="hidden truncate font-mono text-[12.5px] tracking-[-0.01em] @lg/roster:block" translate="no">
          {closer.utmMedium}
        </span>
        <span className={cn(FIGURE, "text-right", booked === 0 && "font-normal text-muted-foreground")}>{booked}</span>
        <span
          className={cn(
            "hidden text-right @lg/roster:block",
            weekly > 0 ? cn(FIGURE, "text-[14px]") : "text-[13px] text-muted-foreground",
          )}
        >
          {weekly > 0 ? `${formatHours(weekly)}h` : "—"}
        </span>
        <ActiveWord active={closer.isActive} />
        <ChevronRightIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
      </button>
      <CloserFlags closer={closer} teams={teams} allClosers={allClosers} unmatched={unmatched} />
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) onToggle();
        }}
      >
        <DialogContent
          className="max-h-[88vh] grid-cols-1 gap-0 overflow-y-auto p-0 sm:max-w-[46rem]"
          onEscapeKeyDown={(event) => {
            // Escape closes the week editor first, then the modal.
            if (scheduleOpen) {
              event.preventDefault();
              onScheduleChange(false);
            }
          }}
        >
          <DialogHeader className="flex-row items-center gap-3 border-b border-border px-5 py-4 text-left">
            <Initials name={closer.displayName} />
            <div className="min-w-0">
              <DialogTitle className="truncate text-[17px] font-semibold">{closer.displayName}</DialogTitle>
              <DialogDescription className="flex flex-wrap items-center gap-x-2 text-[13px]">
                <span>{team.displayName}</span>
                <span aria-hidden="true">·</span>
                <span className="font-mono" translate="no">
                  utm_medium={closer.utmMedium}
                </span>
                <span aria-hidden="true">·</span>
                <span>
                  {booked} booking{booked === 1 ? "" : "s"} in 30 days
                </span>
              </DialogDescription>
            </div>
          </DialogHeader>
          <div className="@container/roster pt-4">
            <CloserEditor
              id={editorId}
          closer={closer}
          team={team}
          teams={teams}
          teamMembers={teamMembers}
          access={access}
          campaign={campaign}
          week={week}
              scheduleOpen={scheduleOpen}
              onScheduleChange={onScheduleChange}
            />
          </div>
        </DialogContent>
      </Dialog>
    </li>
  );
}

/** Amber notes under a row: a UTM that's easy to mistype, or one shared with another closer. */
function CloserFlags({
  closer,
  teams,
  allClosers,
  unmatched,
}: {
  closer: RosterDmCloser;
  teams: readonly Doc<"attributionTeams">[];
  allClosers: readonly RosterDmCloser[];
  unmatched: readonly UnmatchedGroup[];
}) {
  const notes: ReactNode[] = [];
  const stored = closer.utmMedium.trim();
  const odd = /\s/.test(stored) ? "has a space" : stored !== stored.toLowerCase() ? "has capitals" : null;
  if (odd) {
    const letters = (value: string) => normalizeUtm(value).replace(/[^\p{L}\p{N}]+/gu, "");
    const misses = unmatched.filter(
      (group) =>
        group.utmMedium !== null &&
        letters(group.utmMedium) === letters(stored) &&
        normalizeUtm(group.utmMedium) !== normalizeUtm(stored),
    );
    const count = misses.reduce((sum, group) => sum + group.bookings, 0);
    notes.push(
      <span key="odd">
        utm_medium {odd}.{" "}
        {count > 0 ? (
          <>
            {count} {count === 1 ? "booking" : "bookings"} tagged <Code>{misses[0].utmMedium}</Code> matched nobody.
          </>
        ) : (
          "Links typed by hand often drop it."
        )}
      </span>,
    );
  }
  const twin = allClosers.find(
    (other) => other._id !== closer._id && normalizeUtm(other.utmMedium) === normalizeUtm(closer.utmMedium),
  );
  if (twin) {
    const twinTeam = teams.find((row) => row._id === twin.teamId)?.displayName ?? "another team";
    notes.push(
      <span key="twin">
        Shares <Code>{closer.utmMedium}</Code> with {twin.displayName} on {twinTeam}
        {twin.isActive ? "" : " (disabled)"}. Bookings go to whichever is active.
      </span>,
    );
  }
  if (notes.length === 0) return null;
  return (
    <p className="mx-4 -mt-1 mb-2 rounded-[6px] bg-warning-surface px-2 py-[5px] text-[12.5px] text-warning-ink @lg/roster:ml-[54px]">
      {notes.map((note, index) => (
        <span key={index}>
          {index > 0 ? " " : null}
          {note}
        </span>
      ))}
    </p>
  );
}

/** A text field that saves on blur or Enter and goes back on Escape. */
function CommitInput({
  value,
  onCommit,
  className,
  ...props
}: Omit<React.ComponentProps<typeof Input>, "value" | "onChange" | "onBlur" | "onKeyDown"> & {
  value: string;
  onCommit: (next: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    setDraft(value);
  }
  async function commit() {
    if (draft.trim() === value.trim()) {
      setDraft(value);
      return;
    }
    if (!(await onCommit(draft))) setDraft(value);
  }
  return (
    <Input
      {...props}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          setDraft(value);
        }
      }}
      className={cn("h-8 bg-card", className)}
    />
  );
}

function Field({
  label,
  tip,
  htmlFor,
  children,
}: {
  label: string;
  tip?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
}) {
  const text = tip ? <HelpTip tip={tip}>{label}</HelpTip> : label;
  return (
    <div className="flex min-w-0 flex-col gap-[5px]">
      {htmlFor ? (
        <label htmlFor={htmlFor} className={LABEL}>
          {text}
        </label>
      ) : (
        <span className={LABEL}>{text}</span>
      )}
      {children}
    </div>
  );
}

/** B's DM closer, in place: every field saves as it changes, with Undo. */
function CloserEditor({
  id,
  closer,
  team,
  teams,
  teamMembers,
  access,
  campaign,
  week,
  scheduleOpen,
  onScheduleChange,
}: {
  id: string;
  closer: RosterDmCloser;
  team: CoverageTeam;
  teams: readonly Doc<"attributionTeams">[];
  teamMembers: readonly TeamMember[];
  access: TeamAccess;
  campaign: { label: string; utmCampaign: string } | null;
  week: WeekHours;
  scheduleOpen: boolean;
  onScheduleChange: (open: boolean) => void;
}) {
  const updateDmCloser = useMutation(api.attribution.dmClosers.updateDmCloser);
  // The latest server row, and this editor's saves still in flight (see save).
  const latest = useRef(closer);
  const pending = useRef(new Map<string, { value: unknown; token: number }>());
  const nextToken = useRef(0);
  useEffect(() => {
    latest.current = closer;
  }, [closer]);
  const setActive = useMutation(api.attribution.dmClosers.setDmCloserActive);
  const first = firstName(closer.displayName);

  async function withUndo(run: () => Promise<unknown>, message: string, undo: () => Promise<unknown>, field: string) {
    try {
      await run();
      posthog.capture("booking_dm_closer_updated", { field });
      toast.success(message, {
        action: {
          label: "Undo",
          onClick: () => {
            undo().catch((error: unknown) => {
              reportClientError(error, { flow: "booking_dm_closer_undo", field });
              toast.error(getErrorMessage(error, "Couldn’t undo that change."));
            });
          },
        },
      });
      return true;
    } catch (error) {
      reportClientError(error, { flow: "booking_dm_closer_update", field });
      toast.error(getErrorMessage(error, "Couldn’t save that change."));
      return false;
    }
  }

  type Patch = { teamId?: Id<"attributionTeams">; displayName?: string; utmMedium?: string; userId?: Id<"users"> | null };
  // updateDmCloser saves the whole name/team/UTM snapshot, so each write is
  // built from the latest server row plus the fields still in flight from
  // this editor. An in-flight field leaves `pending` when its own save settles
  // (saved or rejected), unless a newer edit of that field has replaced it.
  // Undo puts back only the field it changed, on top of what is current then.
  function snapshot() {
    const current = latest.current;
    const inFlight: Patch = {};
    for (const [key, entry] of pending.current) (inFlight as Record<string, unknown>)[key] = entry.value;
    return {
      dmCloserId: current._id,
      teamId: current.teamId,
      displayName: current.displayName,
      utmMedium: current.utmMedium,
      ...inFlight,
    };
  }
  async function save(patch: Patch) {
    const token = ++nextToken.current;
    const keys = Object.keys(patch) as Array<keyof Patch>;
    for (const key of keys) pending.current.set(key, { value: patch[key], token });
    try {
      await updateDmCloser(snapshot());
    } finally {
      for (const key of keys) {
        if (pending.current.get(key)?.token === token) pending.current.delete(key);
      }
    }
  }
  function update(patch: Patch, message: string, field: string) {
    const current = snapshot();
    const previous: Patch = {};
    for (const key of Object.keys(patch) as Array<keyof Patch>) {
      if (key === "userId") previous.userId = latest.current.userId ?? null;
      else (previous as Record<string, unknown>)[key] = current[key];
    }
    return withUndo(() => save(patch), message, () => save(previous), field);
  }

  const members = teamMembers.filter((member) => member.isActive || member._id === closer.userId);
  const otherTeams = teams.filter((row) => row.isActive || row._id === closer.teamId);

  return (
    <div id={id} className="flex flex-col gap-3 px-5 pb-5">
      <div className="grid grid-cols-1 gap-x-3 gap-y-2.5 @md/roster:grid-cols-2 @xl/roster:grid-cols-3">
        <Field label="Name" tip="Shown in the link portal's Who are you? list and on reports." htmlFor={`${id}-name`}>
          <CommitInput
            id={`${id}-name`}
            value={closer.displayName}
            onCommit={(next) => update({ displayName: next }, `Renamed to ${next.trim()}`, "name")}
          />
        </Field>
        <Field label="Team" tip="Their links carry this team's utm_source, and they get the links on that team's Coverage column. Moving them changes both from now on." htmlFor={`${id}-team`}>
          <NativeSelect
            id={`${id}-team`}
            className="w-full [&_select]:bg-card"
            value={closer.teamId}
            onChange={(event) => {
              const next = teams.find((row) => row._id === event.target.value);
              if (!next) return;
              void update(
                { teamId: next._id },
                `${closer.displayName} moved to ${next.displayName}`,
                "team",
              );
            }}
          >
            {otherTeams.map((row) => (
              <NativeSelectOption key={row._id} value={row._id}>
                {row.displayName}
                {row.isActive ? "" : " (disabled)"}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Field label="utm_medium" tip="The value their links carry as utm_medium. Bookings that come back with it are credited to them. Changing it doesn't rewrite links already sent." htmlFor={`${id}-utm`}>
          <CommitInput
            id={`${id}-utm`}
            value={closer.utmMedium}
            spellCheck={false}
            autoCapitalize="none"
            className="font-mono"
            onCommit={(next) => update({ utmMedium: next }, `${first}’s utm_medium is now ${next.trim()}`, "utm_medium")}
          />
        </Field>
        <Field label="CRM user" tip="Optional. Link them to a CRM login if they also work inside Magnus, so their activity lines up with this DM closer." htmlFor={`${id}-user`}>
          <NativeSelect
            id={`${id}-user`}
            className="w-full [&_select]:bg-card"
            value={closer.userId ?? ""}
            onChange={(event) => {
              const next = (event.target.value || null) as Id<"users"> | null;
              const member = members.find((row) => row._id === next);
              void update(
                { userId: next },
                next ? `${first} linked to ${member?.email ?? "a CRM user"}` : `${first} has no CRM user`,
                "user",
              );
            }}
          >
            <NativeSelectOption value="">Not linked</NativeSelectOption>
            {members.map((member) => (
              <NativeSelectOption key={member._id} value={member._id}>
                {member.email}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Active" tip="On: they appear in the link portal and get credit for bookings. Off: they can't copy links; their history stays.">
          <label className="flex h-8 items-center gap-2.5 text-[13px] text-muted-foreground">
            <Switch
              checked={closer.isActive}
              aria-label={`${closer.displayName} is active`}
              className="data-checked:bg-foreground"
              onCheckedChange={(checked) =>
                void withUndo(
                  () => setActive({ dmCloserId: closer._id, isActive: checked }),
                  checked ? `${first} is back in the portal` : `${first} is hidden from the portal`,
                  () => setActive({ dmCloserId: closer._id, isActive: !checked }),
                  "active",
                )
              }
            />
            {closer.isActive ? "In the portal" : "Hidden from the portal"}
          </label>
        </Field>
      </div>
      <ScheduleBlock
        dmCloserId={closer._id}
        firstName={first}
        week={week}
        open={scheduleOpen}
        onOpenChange={onScheduleChange}
      />
      <CloserGets closer={closer} team={team} access={access} campaign={campaign} />
    </div>
  );
}

/** "What Ana gets · 6 of 7 programs": the team's links, bookable programs first. */
function CloserGets({
  closer,
  team,
  access,
  campaign,
}: {
  closer: RosterDmCloser;
  team: CoverageTeam;
  access: TeamAccess;
  campaign: { label: string; utmCampaign: string } | null;
}) {
  const first = firstName(closer.displayName);
  const frame = "overflow-hidden rounded-[9px] border border-border bg-card";
  const head = "border-b border-border bg-muted/40 px-3 py-2 text-[13.5px] font-semibold";
  if (!closer.isActive || !team.isActive) {
    return (
      <div className={frame}>
        <div className={head}>What {first} gets</div>
        <p className="px-3 py-2.5 text-[13px] text-muted-foreground">
          {!closer.isActive
            ? `Disabled: ${first} can’t pick their name in the portal, so they get no links.`
            : `${team.displayName} is disabled, so its DM closers get no links.`}
        </p>
      </div>
    );
  }
  const rows = [...access.rows].sort((a, b) => Number(b.bookable) - Number(a.bookable));
  const example = rows
    .flatMap((row) => [row.lanes.normal, row.lanes.extended])
    .find((lane) => canBook(lane) && "eventType" in lane && lane.eventType?.bookingBaseUrl);
  const exampleUrl = (() => {
    if (!example || !("eventType" in example) || !example.eventType?.bookingBaseUrl || !campaign) return null;
    try {
      return buildBookingUrl({
        bookingBaseUrl: example.eventType.bookingBaseUrl,
        teamUtmSource: team.utmSource,
        closerUtmMedium: closer.utmMedium,
        campaign: campaign.utmCampaign,
      });
    } catch {
      return null;
    }
  })();

  return (
    <div className={frame}>
      <div className={head}>
        What {first} gets · {access.bookable} of {access.total} {access.total === 1 ? "program" : "programs"}
      </div>
      {rows.length === 0 ? (
        <p className="px-3 py-2.5 text-[13px] text-muted-foreground">No programs yet.</p>
      ) : (
        <div className="-mt-px">
          <GetsRows rows={rows} teamId={team._id} showHead={false} />
        </div>
      )}
      {exampleUrl ? (
        <p className="border-t border-border bg-muted/40 px-3 py-2 font-mono text-[11.5px] break-all text-muted-foreground" translate="no">
          <span className="sr-only">Example link, {campaign?.label} campaign: </span>
          {exampleUrl.replace(/^https?:\/\//, "")}
        </p>
      ) : null}
    </div>
  );
}
