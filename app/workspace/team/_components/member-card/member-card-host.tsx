"use client";

import { useCallback, useLayoutEffect, useRef } from "react";
import dynamic from "next/dynamic";
import { usePathname, useSearchParams } from "next/navigation";

// The member card: one modal for one team member, on any Team page (Members,
// Review, Schedules, Goals, a team's page). Each page mounts <MemberCardHost />
// once; the card lives in the URL:
//   ?member=<key>            the member's `key` from api.team.directory.getDirectory
//   &schedule=<role>         opens that role's week (lead_gen | slack | dm_closer)
//   &from=<report>           a report linked here: the card offers the way back
//   ?worker=<leadGenWorkerId> · ?slackUser=<Slack user id> · ?dmCloser=<dmCloserId>
//                            aliases a report can link to; the host resolves them
//                            to ?member= and keeps &schedule= and &from=.

export type ScheduleRole = "lead_gen" | "slack" | "dm_closer";

export const SCHEDULE_ROLES: readonly ScheduleRole[] = ["lead_gen", "slack", "dm_closer"];

/** Reports that link to a member card, for its "Back to …" link. */
export type MemberCardFrom = "lead-gen" | "qualifications" | "booked-calls";

/** URL params the card owns; closing it removes them. */
export const MEMBER_CARD_PARAMS = ["member", "worker", "slackUser", "dmCloser", "schedule", "record", "from"] as const;

/** The alias params, and the record kind each names. */
const ALIASES = ["worker", "slackUser", "dmCloser"] as const;
export type MemberAlias = { kind: (typeof ALIASES)[number]; id: string };

const MemberCardDialog = dynamic(() => import("./member-card").then((module) => ({ default: module.MemberCardDialog })));

/** Mount once per page. Renders the card when the URL names a member. */
export function MemberCardHost() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const memberKey = searchParams.get("member");
  const aliasKind = memberKey ? null : (ALIASES.find((kind) => searchParams.get(kind)) ?? null);
  const alias: MemberAlias | null = aliasKind ? { kind: aliasKind, id: searchParams.get(aliasKind)! } : null;
  const open = Boolean(memberKey || alias);

  // The record a report linked to, so `&schedule=` opens that record's week
  // when the member has several of the role. Kept in the URL (`&record=`) so a
  // reload or Back opens the same one.
  const scheduleRecord = searchParams.get("record") ?? alias?.id ?? null;

  // Focus goes back to whatever opened the card. A layout effect, so it runs
  // before the dialog moves focus inside itself.
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  useLayoutEffect(() => {
    if (open && !wasOpen.current) {
      const active = document.activeElement;
      opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
    }
    if (!open && wasOpen.current) {
      const target = opener.current;
      opener.current = null;
      if (target?.isConnected) target.focus({ preventScroll: true });
    }
    wasOpen.current = open;
  }, [open]);

  const write = useCallback(
    (change: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(window.location.search);
      change(params);
      const query = params.toString();
      window.history.replaceState(null, "", `${pathname}${query ? `?${query}` : ""}${window.location.hash}`);
    },
    [pathname],
  );

  const close = useCallback(() => {
    write((params) => {
      for (const key of MEMBER_CARD_PARAMS) params.delete(key);
    });
  }, [write]);

  /** An alias, or a key a join or link changed, now names this member. */
  const resolve = useCallback(
    (key: string, recordId?: string) => {
      write((params) => {
        for (const name of ALIASES) params.delete(name);
        params.set("member", key);
        if (recordId) params.set("record", recordId);
      });
    },
    [write],
  );

  const setSchedule = useCallback(
    (forMember: string | null, role: ScheduleRole | null, recordId?: string) => {
      write((params) => {
        // A save that finishes after its card closed (or another member's card
        // opened) must not touch the week now open.
        if (forMember !== null && params.get("member") !== forMember) return;
        if (role) params.set("schedule", role);
        else params.delete("schedule");
        if (recordId) params.set("record", recordId);
        else params.delete("record");
      });
    },
    [write],
  );

  if (!open) return null;
  const schedule = searchParams.get("schedule");
  return (
    <MemberCardDialog
      memberKey={memberKey}
      alias={alias}
      schedule={schedule === "lead_gen" || schedule === "slack" || schedule === "dm_closer" ? schedule : null}
      scheduleRecord={scheduleRecord}
      from={searchParams.get("from")}
      onClose={close}
      onResolve={resolve}
      onScheduleChange={(role, recordId) => setSchedule(memberKey, role, recordId)}
    />
  );
}

/** The href that opens a member's card on this page, keeping the page's other params. */
export function useMemberCardHref() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  return useCallback(
    (memberKey: string, schedule?: ScheduleRole) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const key of MEMBER_CARD_PARAMS) params.delete(key);
      params.set("member", memberKey);
      if (schedule) params.set("schedule", schedule);
      return `${pathname}?${params.toString()}`;
    },
    [pathname, searchParams],
  );
}
