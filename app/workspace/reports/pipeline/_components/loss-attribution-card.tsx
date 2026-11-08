"use client";

import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { getMemberDisplayName, type MemberAvatarIdentity } from "@/app/workspace/_components/member-avatar";
import { BarList, LABEL, ReportCard, ReportNote, RowsSkeleton } from "../../_components/report-ui";
import { formatCount } from "./pipeline-figures";

// Deals a person marked lost in the range: by role, then the eight people
// who marked the most.

type Role = "admin" | "closer" | "unknown";

type LossAttribution = {
  admin: number;
  closer: number;
  unknown: number;
  byActor: Array<{ userId: string; actor: MemberAvatarIdentity; actorRole: Role; count: number }>;
};

const ROLE_WORDS: Record<Role, string> = { closer: "Closer", admin: "Admin", unknown: "Unknown" };
const ROLES: Array<{ key: Role; label: string }> = [
  { key: "closer", label: "Closers" },
  { key: "admin", label: "Admins" },
  { key: "unknown", label: "Unknown" },
];
const TOP_ACTORS = 8;

export function LossAttributionCard({
  lossAttribution,
  isTruncated,
  rangeLabel,
  rangePhrase,
  reloading,
}: {
  lossAttribution: LossAttribution | undefined;
  /** The read stopped at its bound, so the counts cover part of the range. */
  isTruncated: boolean;
  rangeLabel: string;
  rangePhrase: string;
  reloading?: boolean;
}) {
  const total = lossAttribution ? lossAttribution.admin + lossAttribution.closer + lossAttribution.unknown : 0;
  const actors = lossAttribution?.byActor.slice(0, TOP_ACTORS) ?? [];
  return (
    <ReportCard
      title="Losses by who marked them"
      meta={lossAttribution === undefined ? rangeLabel : `${rangeLabel} · ${formatCount(total)} loss${total === 1 ? "" : "es"}`}
      container="@container/losses"
      reloading={reloading}
    >
      {lossAttribution === undefined ? (
        <RowsSkeleton rows={6} label="Loading losses" />
      ) : (
        <>
          {isTruncated ? (
            <ReportNote lead="Capped.">This range holds more losses than the report reads at once, so the counts are partial. Narrow the range.</ReportNote>
          ) : null}
          {total === 0 ? (
            <SectionEmpty title={`No deals marked lost ${rangePhrase}.`}>
              No-shows, cancellations and Slack expiries aren&apos;t counted here.
            </SectionEmpty>
          ) : (
            <>
              <ReportNote>Deals a person marked lost. No-shows, cancellations and Slack expiries are left out.</ReportNote>
              <BarList
                label="Losses by role"
                labelColumn="9rem"
                rows={ROLES.map((role) => ({
                  key: role.key,
                  label: role.label,
                  value: lossAttribution[role.key],
                  display: formatCount(lossAttribution[role.key]),
                }))}
              />
              {actors.length > 0 ? (
                <>
                  <p className={`${LABEL} flex min-h-7 items-center border-y bg-muted/40 px-4`}>
                    {lossAttribution.byActor.length > TOP_ACTORS ? `Top ${TOP_ACTORS} people` : "By person"}
                  </p>
                  <BarList
                    label="Losses by person"
                    labelColumn="13rem"
                    rows={actors.map((actor) => ({
                      key: actor.userId,
                      label: getMemberDisplayName(actor.actor),
                      meta: ROLE_WORDS[actor.actorRole],
                      value: actor.count,
                      display: formatCount(actor.count),
                    }))}
                  />
                </>
              ) : null}
            </>
          )}
        </>
      )}
    </ReportCard>
  );
}
