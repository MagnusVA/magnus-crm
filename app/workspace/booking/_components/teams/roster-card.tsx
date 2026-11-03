"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { toast } from "sonner";
import posthog from "posthog-js";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { buildBookingUrl } from "@/app/dm-links/[portalSlug]/_components/build-booking-url";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { getErrorMessage } from "@/lib/errors";
import { reportClientError } from "@/lib/observability/report-client-error";
import { cn } from "@/lib/utils";
import type { CoverageTeam } from "../booking-model";
import { GetsRows } from "./gets-table";
import { canBook, type TeamAccess } from "./team-access";
import { ActiveWord, CardHead, CARD, Code, FIGURE, firstName, formatRate, Initials, LABEL } from "./team-ui";
import { normalizeUtm } from "./utm-suggestions";

export type RosterDmCloser = FunctionReturnType<typeof api.attribution.dmClosers.listDmClosers>[number];
type TeamMember = FunctionReturnType<typeof api.users.queries.listTeamMembers>[number];
type UnmatchedGroup = FunctionReturnType<typeof api.bookingSetup.queries.getBookingActivity>["unmatchedUtms"][number];

// Mirrors MAX_HOURLY_RATE_MINOR in convex/attribution/dmClosers.ts ($100,000).
const MAX_RATE_MAJOR = 100_000;

const ROW =
  "grid w-full items-center gap-2.5 px-4 text-left grid-cols-[28px_minmax(0,1fr)_40px_72px_14px] @lg/roster:grid-cols-[28px_minmax(0,1.3fr)_minmax(0,1fr)_52px_58px_76px_14px]";

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
  onToggle,
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
  onToggle: (dmCloserId: string) => void;
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
      <CardHead title={<span id="roster-title">Roster</span>} meta="Click a DM closer to edit them and see their links">
        <Button variant="outline" size="sm" onClick={onNew}>
          <PlusIcon aria-hidden="true" />
          New DM closer
        </Button>
      </CardHead>
      <div aria-hidden="true" className={cn(ROW, "min-h-[34px] border-b border-border pt-2.5 pb-2")}>
        <span />
        <span className={LABEL}>DM closer</span>
        <span className={cn(LABEL, "hidden @lg/roster:block")}>utm_medium</span>
        <span className={cn(LABEL, "text-right")}>30d</span>
        <span className={cn(LABEL, "hidden text-right @lg/roster:block")}>Rate</span>
        <span className={LABEL}>Status</span>
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
              onToggle={() => onToggle(closer._id)}
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
  onToggle,
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
  onToggle: () => void;
}) {
  const rate = formatRate(closer.hourlyRateMinor);
  const editorId = `closer-${closer._id}`;
  return (
    <li id={`row-${closer._id}`} className={cn("scroll-mt-4 border-t border-border first:border-t-0", open && "bg-muted/25")}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? editorId : undefined}
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
        <span className="hidden text-right text-[13px] text-muted-foreground @lg/roster:block">{rate ? `${rate}/h` : "—"}</span>
        <ActiveWord active={closer.isActive} />
        <ChevronDownIcon
          aria-hidden="true"
          className={cn("size-3.5 text-muted-foreground transition-transform duration-200", open && "rotate-180")}
        />
      </button>
      <CloserFlags closer={closer} teams={teams} allClosers={allClosers} unmatched={unmatched} />
      {open ? (
        <CloserEditor
          id={editorId}
          closer={closer}
          team={team}
          teams={teams}
          teamMembers={teamMembers}
          access={access}
          campaign={campaign}
        />
      ) : null}
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

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-[5px]">
      {htmlFor ? (
        <label htmlFor={htmlFor} className={LABEL}>
          {label}
        </label>
      ) : (
        <span className={LABEL}>{label}</span>
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
}: {
  id: string;
  closer: RosterDmCloser;
  team: CoverageTeam;
  teams: readonly Doc<"attributionTeams">[];
  teamMembers: readonly TeamMember[];
  access: TeamAccess;
  campaign: { label: string; utmCampaign: string } | null;
}) {
  const updateDmCloser = useMutation(api.attribution.dmClosers.updateDmCloser);
  // The latest server row, and this editor's saves still in flight (see save).
  const latest = useRef(closer);
  const pending = useRef(new Map<string, { value: unknown; token: number }>());
  const nextToken = useRef(0);
  useEffect(() => {
    latest.current = closer;
  }, [closer]);
  const setRate = useMutation(api.attribution.dmClosers.setDmCloserHourlyRate);
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
  const rateValue = closer.hourlyRateMinor === undefined ? "" : String(closer.hourlyRateMinor / 100);

  return (
    <div id={id} className="flex flex-col gap-3 px-4 pt-1 pb-4 @lg/roster:pl-[54px]">
      <div className="grid grid-cols-1 gap-x-3 gap-y-2.5 @md/roster:grid-cols-2 @xl/roster:grid-cols-3">
        <Field label="Name" htmlFor={`${id}-name`}>
          <CommitInput
            id={`${id}-name`}
            value={closer.displayName}
            onCommit={(next) => update({ displayName: next }, `Renamed to ${next.trim()}`, "name")}
          />
        </Field>
        <Field label="Team" htmlFor={`${id}-team`}>
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
        <Field label="utm_medium" htmlFor={`${id}-utm`}>
          <CommitInput
            id={`${id}-utm`}
            value={closer.utmMedium}
            spellCheck={false}
            autoCapitalize="none"
            className="font-mono"
            onCommit={(next) => update({ utmMedium: next }, `${first}’s utm_medium is now ${next.trim()}`, "utm_medium")}
          />
        </Field>
        <Field label="Rate / h ($)" htmlFor={`${id}-rate`}>
          <CommitInput
            id={`${id}-rate`}
            value={rateValue}
            inputMode="decimal"
            placeholder="—"
            className="font-condensed text-[15px] tabular-nums"
            onCommit={async (raw) => {
              const trimmed = raw.trim().replace(/^\$/, "");
              const major = trimmed === "" ? null : Number(trimmed);
              if (major !== null && (!Number.isFinite(major) || major < 0 || major > MAX_RATE_MAJOR)) {
                toast.error(`Enter an hourly rate from 0 to ${MAX_RATE_MAJOR}, or leave it blank.`);
                return false;
              }
              const next = major === null ? null : Math.round(major * 100);
              const previous = closer.hourlyRateMinor ?? null;
              return withUndo(
                () => setRate({ dmCloserId: closer._id, hourlyRateMinor: next }),
                next === null ? `${first} has no rate` : `${first}: ${formatRate(next)}/h`,
                () => setRate({ dmCloserId: closer._id, hourlyRateMinor: previous }),
                "rate",
              );
            }}
          />
        </Field>
        <Field label="CRM user" htmlFor={`${id}-user`}>
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
        <Field label="Active">
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
