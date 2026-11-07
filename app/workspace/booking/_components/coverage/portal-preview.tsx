"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import posthog from "@/lib/posthog-browser";
import { CheckIcon, CopyIcon, EyeIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { cn } from "@/lib/utils";
import { buildBookingUrl } from "@/app/dm-links/[portalSlug]/_components/build-booking-url";
import { modeLabel, type CoverageEventType, type SchedulingMode } from "../booking-model";
import { EventTypeMark } from "../coverage-cell";
import { useCoverage } from "./coverage-context";
import { closerLinks, firstName, ISSUE_WORD, isWorking, plural, refKey } from "./coverage-model";

const LABEL = "font-condensed text-[11px] leading-none font-semibold tracking-[0.14em] text-muted-foreground uppercase";

type Copied = { programId: string; programName: string; mode: SchedulingMode; url: string; parts: UrlParts } | null;
type UrlParts = { base: string; source: string; medium: string; campaign: string };

/**
 * Concept C's right column: the DM link portal exactly as one DM closer
 * gets it now. Only working links show; X-ray says where each comes from.
 */
export function PortalPreview({ className }: { className?: string }) {
  const { board, closers, previewCloserId, setPreviewCloser, xray, setXray, openCell, hint, dismissHint } = useCoverage();
  const presets = useQuery(api.linkPortal.campaignQueries.listCampaignPresetsForSettings, {});
  const portal = useQuery(api.linkPortal.configQueries.getPortalConfigForSettings, {});
  const activePresets = useMemo(() => (presets ?? []).filter((preset) => preset.isActive), [presets]);
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const campaign =
    activePresets.find((preset) => preset._id === campaignId) ?? activePresets.find((preset) => preset.isDefault) ?? activePresets[0] ?? null;

  const closer = closers?.find((candidate) => candidate._id === previewCloserId) ?? null;
  const team = closer ? board.teams.find((candidate) => candidate._id === closer.teamId) ?? null : null;
  const groups = useMemo(() => (team ? closerLinks(board, team) : []), [board, team]);
  const offered = groups.filter((group) => group.links.some((link) => isWorking(link.face)));
  const linkCount = groups.reduce((sum, group) => sum + group.links.filter((link) => isWorking(link.face)).length, 0);
  const missing = groups.flatMap((group) =>
    group.links
      .filter((link) => link.face.kind === "gap" || link.face.kind === "broken")
      .map((link) => ({ program: group.program, mode: link.mode, broken: link.face.kind === "broken" })),
  );
  const selectId = useId();
  const hintTeam = hint ? board.teams.find((candidate) => candidate._id === hint[0]) : null;
  const hintCloser = hintTeam ? closers?.find((candidate) => candidate.teamId === hintTeam._id) : null;

  return (
    <aside aria-label="Live portal preview" className={cn("flex min-h-0 flex-col gap-[9px]", className)}>
      <div className="flex flex-none flex-col gap-[7px]">
        <div className="flex items-center gap-2">
          <span className={LABEL}>Live portal preview</span>
          <span className="ml-auto inline-flex h-5 items-center rounded-[4px] border border-input px-1.5 font-condensed text-[11px] leading-none font-bold tracking-[0.1em] text-muted-foreground uppercase">
            {portal && !portal.isEnabled ? "Portal is off" : "Matches live"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor={selectId} className="text-[12.5px] whitespace-nowrap text-muted-foreground">
            Preview as
          </label>
          <select
            id={selectId}
            value={previewCloserId ?? ""}
            disabled={!closers || closers.length === 0}
            onChange={(event) => {
              setPreviewCloser(event.target.value);
              posthog.capture("booking_preview_closer_changed");
            }}
            className="h-8 min-w-0 flex-1 appearance-none rounded-[7px] border border-input bg-card bg-[url('data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20width=%2212%22%20height=%2212%22%20viewBox=%220%200%2024%2024%22%20fill=%22none%22%20stroke=%22%234f596b%22%20stroke-width=%222.2%22%3E%3Cpath%20d=%22m6%209%206%206%206-6%22/%3E%3C/svg%3E')] bg-[position:right_9px_center] bg-no-repeat pr-7 pl-2.5 text-[13.5px] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {!closers || closers.length === 0 ? <option value="">No active DM closers</option> : null}
            {board.teams.map((candidate) => {
              const members = (closers ?? []).filter((member) => member.teamId === candidate._id);
              if (members.length === 0) return null;
              return (
                <optgroup key={candidate._id} label={candidate.displayName}>
                  {members.map((member) => (
                    <option key={member._id} value={member._id}>
                      {member.displayName}
                    </option>
                  ))}
                </optgroup>
              );
            })}
          </select>
          <button
            type="button"
            aria-pressed={xray}
            onClick={() => {
              setXray(!xray);
              posthog.capture("booking_preview_xray_toggled", { on: !xray });
            }}
            title="Show where each link comes from"
            className={cn(
              "inline-flex h-8 flex-none items-center gap-1.5 rounded-[7px] border border-input bg-card px-2.5 text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
              xray && "border-foreground bg-foreground text-background",
            )}
          >
            <EyeIcon aria-hidden className="size-[15px]" />
            X-ray
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 justify-center">
        <Phone
          closerName={closer?.displayName ?? null}
          closerMedium={closer?.utmMedium ?? ""}
          team={team}
          groups={groups}
          presets={activePresets}
          campaign={campaign}
          onCampaign={setCampaignId}
          loading={closers === undefined || presets === undefined}
        />
      </div>

      {closer ? (
        <p className="flex-none px-0.5 text-[12.5px] leading-[1.4] text-muted-foreground">
          <b className="font-semibold text-foreground">
            {firstName(closer.displayName)} gets {plural(offered.length, "program")} · {plural(linkCount, "link")}.
          </b>{" "}
          {missing.length > 0 ? (
            <span className="text-danger-ink">
              Missing:{" "}
              {missing.map((item, index) => (
                <span key={`${item.program._id}|${item.mode}`}>
                  <button
                    type="button"
                    className="underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
                    onClick={() => team && openCell({ teamId: team._id, programId: item.program._id, mode: item.mode })}
                  >
                    {item.program.name} · {modeLabel(item.mode)}
                    {item.broken ? " (broken)" : ""}
                  </button>
                  {index < missing.length - 1 ? ", " : "."}
                </span>
              ))}
            </span>
          ) : (
            "Nothing missing."
          )}
        </p>
      ) : null}

      {hintTeam && hintCloser && closer ? (
        <div className="cov-row-in flex flex-none items-center gap-2 rounded-[7px] border border-border bg-card px-2.5 py-2 text-[12.5px]">
          <EyeIcon aria-hidden className="size-[15px] flex-none text-muted-foreground" />
          <span className="min-w-0">
            That change reaches <b className="font-semibold">{hintTeam.displayName}</b>
            {hint && hint.length > 1 ? ` and ${plural(hint.length - 1, "other team")}` : ""}, not {firstName(closer.displayName)}.
          </span>
          <button
            type="button"
            className="ml-auto font-medium whitespace-nowrap text-primary-ink hover:underline"
            onClick={() => {
              setPreviewCloser(hintCloser._id);
              dismissHint();
            }}
          >
            Preview {firstName(hintCloser.displayName)}
          </button>
        </div>
      ) : null}
    </aside>
  );
}

function Phone({
  closerName,
  closerMedium,
  team,
  groups,
  presets,
  campaign,
  onCampaign,
  loading,
}: {
  closerName: string | null;
  closerMedium: string;
  team: ReturnType<typeof useCoverage>["board"]["teams"][number] | null;
  groups: ReturnType<typeof closerLinks>;
  presets: Array<{ _id: string; label: string; utmCampaign: string }>;
  campaign: { _id: string; label: string; utmCampaign: string } | null;
  onCampaign: (id: string) => void;
  loading: boolean;
}) {
  const { xray, litTile, setLitCell, openCell } = useCoverage();
  const [copied, setCopied] = useState<Copied>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const who = `${closerName ?? ""}|${team?._id ?? ""}`;
  const [shownWho, setShownWho] = useState(who);
  const [swapKey, setSwapKey] = useState(0);
  if (shownWho !== who) {
    setShownWho(who);
    setSwapKey((key) => key + 1);
    setCopied(null);
  }

  // New programs and links slide in when a change gives this closer more:
  // `previous` is what the phone showed before the last change.
  const tiles: string[] = [];
  const programs = new Set<string>();
  for (const group of groups) {
    for (const link of group.links) {
      if (link.face.kind === "own" || link.face.kind === "inherited") {
        tiles.push(`${group.program._id}|${link.mode}|${link.face.eventType?._id ?? ""}`);
        programs.add(group.program._id);
      }
    }
  }
  const signature = `${who}#${tiles.join(",")}`;
  const [snapshot, setSnapshot] = useState({ signature, who, tiles: new Set(tiles), programs });
  const [previous, setPrevious] = useState<typeof snapshot | null>(null);
  if (snapshot.signature !== signature) {
    setSnapshot({ signature, who, tiles: new Set(tiles), programs });
    setPrevious(snapshot.who === who ? snapshot : null);
  }

  // Scroll the phone to a tile lit from the matrix.
  useEffect(() => {
    if (!litTile) return;
    const element = listRef.current?.querySelector<HTMLElement>(`[data-tile="${litTile}"]`);
    const section = element?.closest<HTMLElement>("[data-pg]");
    if (section && listRef.current) {
      listRef.current.scrollTo({ top: Math.max(0, section.offsetTop - 80), behavior: "smooth" });
    }
  }, [litTile]);

  async function copy(programId: string, programName: string, mode: SchedulingMode, eventType: CoverageEventType) {
    if (!team || !campaign || !eventType.bookingBaseUrl) return;
    let url: string;
    try {
      url = buildBookingUrl({
        bookingBaseUrl: eventType.bookingBaseUrl,
        teamUtmSource: team.utmSource,
        closerUtmMedium: closerMedium,
        campaign: campaign.utmCampaign,
      });
    } catch {
      return;
    }
    await navigator.clipboard?.writeText(url).catch(() => undefined);
    posthog.capture("booking_preview_link_copied", { mode });
    setFlash(`${programId}|${mode}`);
    window.setTimeout(() => setFlash(null), 1600);
    setCopied({
      programId,
      programName,
      mode,
      url,
      parts: { base: eventType.bookingBaseUrl.replace(/^https?:\/\//, ""), source: team.utmSource, medium: closerMedium, campaign: campaign.utmCampaign },
    });
  }

  return (
    <div className="relative h-[min(620px,max(440px,calc(100dvh-24rem)))] w-[min(296px,100%)] flex-none rounded-[42px] bg-[#0b0f18] p-[9px]">
      <div className="relative flex h-full flex-col overflow-hidden rounded-[34px] bg-background">
        <div aria-hidden className="absolute top-2 left-1/2 z-[5] h-[22px] w-[84px] -translate-x-1/2 rounded-[12px] bg-[#0b0f18]" />
        <div aria-hidden className="flex h-9 flex-none items-center justify-between bg-board px-6 pt-1.5 text-[13px] font-semibold text-white">
          <span>9:41</span>
          <span className="flex items-end gap-[3px]">
            {[4, 6, 8, 10].map((height) => (
              <i key={height} className="block w-[3px] rounded-[1px] bg-white" style={{ height }} />
            ))}
          </span>
        </div>

        <div className="dark flex-none bg-board px-3.5 pt-1 pb-2.5 text-board-foreground">
          <div className="font-condensed text-[11px] leading-none font-semibold tracking-[0.16em] text-board-muted uppercase">Booking links</div>
          {closerName && team ? (
            <>
              <div className="mt-1.5 text-[19px] leading-[1.1] font-semibold">Hi {firstName(closerName)}</div>
              <div className="mt-0.5 text-[12px] text-board-muted">{team.displayName} · links credit you</div>
              <div className="mt-2.5 flex flex-wrap items-center gap-[5px]">
                <span className="mr-0.5 font-condensed text-[11px] leading-none font-semibold tracking-[0.12em] text-board-muted uppercase">Campaign</span>
                {presets.length === 0 ? (
                  <span className="text-[12px] text-board-danger">No campaign presets: the portal can’t build links.</span>
                ) : (
                  presets.map((preset) => (
                    <button
                      key={preset._id}
                      type="button"
                      aria-pressed={campaign?._id === preset._id}
                      onClick={() => onCampaign(preset._id)}
                      className={cn(
                        "h-[26px] flex-none rounded-[6px] border border-board-foreground/15 bg-board-raised px-[9px] font-condensed text-[12.5px] leading-none font-semibold tracking-[0.04em] whitespace-nowrap text-board-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        campaign?._id === preset._id && "border-board-foreground bg-board-foreground text-board",
                      )}
                    >
                      {preset.label}
                    </button>
                  ))
                )}
              </div>
            </>
          ) : (
            <div className="mt-1.5 text-[19px] leading-[1.1] font-semibold">{loading ? "Loading…" : "Who are you?"}</div>
          )}
        </div>

        <div ref={listRef} key={swapKey} className={cn("relative min-h-0 flex-1 overflow-auto [scrollbar-width:none]", swapKey > 0 && "cov-swap")}>
          {!loading && (!closerName || !team) ? (
            <div className="px-[18px] py-7 text-center text-[13px] text-muted-foreground">
              No active DM closers yet. Add one on the team’s page in Team › Teams to preview their portal.
            </div>
          ) : null}
          {team && closerName
            ? groups.map((group) => {
                const working = group.links.filter((link) => isWorking(link.face));
                const ghosts = xray ? group.links.filter((link) => link.face.kind === "gap" || link.face.kind === "broken") : [];
                if (working.length === 0 && ghosts.length === 0) return null;
                const visible = group.links.filter((link) => isWorking(link.face) || (xray && (link.face.kind === "gap" || link.face.kind === "broken")));
                const enteringProgram = previous !== null && !previous.programs.has(group.program._id) && working.length > 0;
                return (
                  <div
                    key={group.program._id}
                    data-pg={group.program._id}
                    className={cn("border-b border-border bg-card px-3 pt-[9px] pb-2.5", enteringProgram && "cov-enter")}
                  >
                    <div className="mb-1.5 text-[13.5px] font-semibold">{group.program.name}</div>
                    <div className={cn("grid gap-1.5", visible.length === 1 ? "grid-cols-1" : "grid-cols-2")}>
                      {visible.map((link) => {
                        const tileKey = `${group.program._id}|${link.mode}`;
                        const sourceRef = { teamId: link.source === "own" ? team._id : null, programId: group.program._id, mode: link.mode };
                        if (link.face.kind === "own" || link.face.kind === "inherited") {
                          const eventType = link.face.eventType;
                          const isNew =
                            previous !== null && !enteringProgram && !previous.tiles.has(`${tileKey}|${eventType?._id ?? ""}`);
                          const isCopied = flash === tileKey;
                          return (
                            <button
                              key={link.mode}
                              type="button"
                              data-tile={tileKey}
                              disabled={!campaign || !eventType}
                              onClick={() => eventType && void copy(group.program._id, group.program.name, link.mode, eventType)}
                              onMouseEnter={() => setLitCell(refKey(sourceRef))}
                              onMouseLeave={() => setLitCell(null)}
                              onFocus={() => setLitCell(refKey(sourceRef))}
                              onBlur={() => setLitCell(null)}
                              aria-label={`Copy ${group.program.name} ${modeLabel(link.mode)} link`}
                              className={cn(
                                "flex min-h-[42px] min-w-0 items-center justify-between gap-1.5 rounded-[7px] border border-input bg-card py-1.5 pr-2 pl-[9px] text-left outline-none hover:border-foreground focus-visible:border-foreground disabled:cursor-default",
                                litTile === tileKey && "shadow-[0_0_0_2px_var(--color-stage-booked)]",
                                isCopied && "border-primary bg-primary text-primary-foreground",
                                isNew && "cov-new",
                              )}
                            >
                              <span className="flex min-w-0 flex-col">
                                <span className="font-condensed text-[12.5px] leading-none font-bold tracking-[0.08em] uppercase">
                                  {isCopied ? "Copied" : modeLabel(link.mode)}
                                </span>
                                <span className={cn("mt-[3px] truncate text-[12px] whitespace-nowrap", isCopied ? "text-primary-foreground" : "text-muted-foreground")}>
                                  {eventType?.calendlyDurationMinutes ? `${eventType.calendlyDurationMinutes} min` : "Tap to copy"}
                                </span>
                                {xray ? (
                                  <span className="mt-1 flex min-w-0 items-center gap-1 text-[12px] leading-[1.2] text-stage-booked-ink">
                                    <span className="flex-none">{link.source === "shared" ? "↳ Shared" : "Own"} ·</span>
                                    <EventTypeMark color={eventType?.calendlyColor} />
                                    <span className="truncate">{eventType?.displayName}</span>
                                  </span>
                                ) : null}
                              </span>
                              {isCopied ? <CheckIcon aria-hidden className="size-[15px] flex-none" /> : <CopyIcon aria-hidden className="size-[15px] flex-none" />}
                            </button>
                          );
                        }
                        const why =
                          link.face.kind === "broken"
                            ? ISSUE_WORD[link.face.issue].toLowerCase()
                            : team.usesShared
                              ? "Shared is empty"
                              : "no route";
                        return (
                          <button
                            key={link.mode}
                            type="button"
                            onClick={() => openCell({ teamId: team._id, programId: group.program._id, mode: link.mode })}
                            title="Open this cell"
                            className="flex min-h-[42px] min-w-0 flex-col justify-center rounded-[7px] border border-dashed border-destructive/60 bg-destructive/5 py-1.5 pr-2 pl-[9px] text-left text-danger-ink outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <span className="font-condensed text-[12.5px] leading-none font-bold tracking-[0.08em] uppercase">{modeLabel(link.mode)}</span>
                            <span className="mt-[3px] truncate text-[12px]">Hidden · {why}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })
            : null}
          {team && closerName && groups.every((group) => !group.links.some((link) => isWorking(link.face))) && !xray ? (
            <div className="px-[18px] py-7 text-center text-[13px] text-muted-foreground">
              No links yet for {team.displayName}.
              <br />
              Fill its cells in the matrix.
            </div>
          ) : null}
          {team && closerName ? (
            <p className="px-3.5 pt-2.5 pb-4 text-center text-[12px] text-muted-foreground">
              Tap a link to copy it. Each link carries your name, so the booking credits you.
            </p>
          ) : null}
        </div>

        {copied ? (
          <div className="cov-sheet-up absolute inset-x-0 bottom-0 z-[6] border-t border-border bg-card px-3.5 pt-3 pb-4 shadow-[0_-10px_24px_rgba(20,26,40,.12)]">
            <div className="flex items-center gap-1.5 text-[13.5px] font-semibold">
              <CheckIcon aria-hidden className="size-[15px]" />
              Copied · {copied.programName} · {modeLabel(copied.mode)}
            </div>
            <div className="my-2 rounded-[7px] border border-border bg-background p-2 font-mono text-[11.5px] leading-[1.45] break-all">
              {copied.parts.base}?<span className="font-semibold text-stage-booked-ink">utm_source={copied.parts.source}</span>&amp;
              <span className="font-semibold text-stage-follow-up-ink">utm_medium={encodeURIComponent(copied.parts.medium)}</span>&amp;
              <span className="font-semibold text-warning-ink">utm_campaign={copied.parts.campaign}</span>
            </div>
            <div className="mb-2 text-[12px] text-muted-foreground">
              Preview copies aren’t logged.
              {/\s|[A-Z]/.test(copied.parts.medium) ? <b className="ml-1 text-warning-ink">utm_medium has a space or capitals.</b> : null}
            </div>
            <button
              type="button"
              autoFocus
              onClick={() => setCopied(null)}
              className="h-[26px] rounded-[5.6px] border border-input bg-background px-2 text-[12.5px] font-medium outline-none hover:bg-card focus-visible:ring-2 focus-visible:ring-ring"
            >
              Done
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
