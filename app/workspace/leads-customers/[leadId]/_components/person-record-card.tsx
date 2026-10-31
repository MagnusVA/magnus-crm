"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useQuery } from "convex/react";
import { useRole } from "@/components/auth/role-context";
import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import {
  ENROLLMENT_STATUS_LABELS,
  type EnrollmentStatus,
} from "@/convex/enrollments/validators";
import {
  DISPOSITION_LABELS,
  LIFECYCLE_STAGE_LABELS,
  LIFECYCLE_STAGES,
} from "@/convex/leads/lifecycle";
import { inactiveDays } from "@/convex/lib/respark/settings";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import { formatCash } from "@/lib/closer-pipeline";
import { cn } from "@/lib/utils";
import {
  DetailCard,
  DetailCardFooter,
} from "@/app/workspace/closer/meetings/_components/detail-card";
import {
  useEntityDetail,
  type EntityDetailEnrollment,
} from "./entity-detail-context";
import { EnrollmentStatusControl } from "./enrollment-status-control";
import type { LifecycleChangeMode } from "./lifecycle-change-dialog";
import { personDate, plural } from "./person-format";

const LifecycleChangeDialog = dynamic(() =>
  import("./lifecycle-change-dialog").then((module) => module.LifecycleChangeDialog),
);

const ENROLLMENT_INK: Record<EnrollmentStatus, string> = {
  active: "text-stage-won-ink",
  paused: "text-warning-ink",
  churned: "text-danger-ink",
};

const CHANGED_VERB: Record<EnrollmentStatus, string> = {
  active: "Reactivated",
  paused: "Paused",
  churned: "Churned",
};

const DISPOSITION_SOURCE_LABELS = {
  system: "Set by the CRM",
  admin: "Set by an admin",
  respark: "Set in a respark, by a lead generator",
} as const;

const SOCIAL_LABELS: Record<string, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  facebook: "Facebook",
  twitter: "X",
  x: "X",
  linkedin: "LinkedIn",
  youtube: "YouTube",
  wechat: "WeChat",
  whatsapp: "WhatsApp",
};

function socialLabel(type: string) {
  return SOCIAL_LABELS[type.toLowerCase()] ?? type.charAt(0).toUpperCase() + type.slice(1);
}

const digits = (value: string) => value.replace(/\D/g, "");

/**
 * The rest of the person's record, one ruled row per fact: how to reach
 * them, the identifiers that decide who a booking belongs to, their
 * programs, portal notes, and the lifecycle with the admin's controls.
 */
export function PersonRecordCard() {
  const { lead, identifiers, enrollments } = useEntityDetail();
  const { isAdmin } = useRole();
  const [mode, setMode] = useState<LifecycleChangeMode | null>(null);
  const handles = lead.socialHandles ?? [];

  // Identifiers the contact rows above don't already show.
  const shown = new Set<string>([
    ...(lead.email ? [`email:${lead.email.trim().toLowerCase()}`] : []),
    ...(lead.phone ? [`phone:${digits(lead.phone)}`] : []),
    ...handles.map((handle) => `${handle.type.toLowerCase()}:${handle.handle.replace(/^@/, "").toLowerCase()}`),
  ]);
  const otherIdentifiers = identifiers.filter((identifier) => {
    const key =
      identifier.type === "phone"
        ? `phone:${digits(identifier.value)}`
        : `${identifier.type}:${identifier.value.replace(/^@/, "").toLowerCase()}`;
    return !shown.has(key);
  });

  // A customer's stage follows their payments; voiding the payment moves it.
  const canMoveBack = lead.lifecycleStage !== "prospect" && lead.status !== "converted";

  return (
    <DetailCard title="Record">
      <dl className="divide-y">
        <RecordRow label="Phone">
          {lead.phone ? (
            <a
              href={`tel:${lead.phone}`}
              className="rounded-sm font-condensed text-[0.9375rem] font-semibold tracking-[0.02em] tabular-nums hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              translate="no"
            >
              {lead.phone}
            </a>
          ) : (
            <NotRecorded />
          )}
        </RecordRow>
        <RecordRow label="Email">
          {lead.email ? (
            <a
              href={`mailto:${lead.email}`}
              className="rounded-sm break-all hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              translate="no"
            >
              {lead.email}
            </a>
          ) : (
            <NotRecorded />
          )}
        </RecordRow>
        {handles.map((handle) => (
          <RecordRow key={`${handle.type}:${handle.handle}`} label={socialLabel(handle.type)}>
            <span className="break-all" translate="no">
              @{handle.handle.replace(/^@/, "")}
            </span>
          </RecordRow>
        ))}
        {otherIdentifiers.length > 0 ? (
          <RecordRow label="Also uses">
            <ul className="flex flex-col gap-0.5">
              {otherIdentifiers.map((identifier) => (
                <li key={identifier._id} className="break-all" translate="no">
                  {identifier.rawValue}
                  <span className="font-normal text-muted-foreground">
                    {" · "}
                    {identifier.type === "email"
                      ? "Email"
                      : identifier.type === "phone"
                        ? "Phone"
                        : socialLabel(identifier.type)}
                  </span>
                </li>
              ))}
            </ul>
          </RecordRow>
        ) : null}
        {enrollments.length > 0 ? (
          <RecordRow label={enrollments.length === 1 ? "Program" : "Programs"}>
            <ul className="flex flex-col gap-2.5">
              {enrollments.map((enrollment) => (
                <EnrollmentEntry key={enrollment.enrollmentId} enrollment={enrollment} />
              ))}
            </ul>
          </RecordRow>
        ) : null}
        <PortalNotesRow />
        <StageRow />
        <DispositionRow />
        <LastTouchRow />
      </dl>
      {isAdmin && lead.status !== "merged" ? (
        <DetailCardFooter>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={!canMoveBack} onClick={() => setMode("move_back")}>
              Move back
            </Button>
            <Button size="sm" variant="outline" onClick={() => setMode("disposition")}>
              Set disposition
            </Button>
          </div>
        </DetailCardFooter>
      ) : null}
      {mode ? (
        <LifecycleChangeDialog
          open
          onOpenChange={(open) => {
            if (!open) setMode(null);
          }}
          mode={mode}
          leadId={lead._id}
          stage={lead.lifecycleStage}
          disposition={lead.disposition}
        />
      ) : null}
    </DetailCard>
  );
}

function RecordRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6.25rem_minmax(0,1fr)] gap-x-2.5 px-4 py-2.5">
      <dt className="pt-px text-[0.8125rem] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 font-medium">{children}</dd>
    </div>
  );
}

function NotRecorded() {
  return <span className="font-normal text-muted-foreground">Not recorded</span>;
}

function EnrollmentEntry({ enrollment }: { enrollment: EntityDetailEnrollment }) {
  const { setting } = useBusinessDay();
  const { hasPermission } = useRole();
  const now = useNow();
  const paid =
    enrollment.totalPaidMinor !== null && enrollment.currency
      ? formatCash(enrollment.totalPaidMinor, enrollment.currency)
      : plural(enrollment.paymentCount, "payment");

  return (
    <li className="flex min-w-0 flex-col gap-0.5">
      <span className="flex flex-wrap items-baseline gap-x-2">
        <span translate="no">{enrollment.programName}</span>
        <span
          className={cn(
            "font-condensed text-[0.8125rem] leading-none font-bold tracking-[0.08em] uppercase",
            ENROLLMENT_INK[enrollment.status],
          )}
        >
          {ENROLLMENT_STATUS_LABELS[enrollment.status]}
        </span>
      </span>
      <span className="text-[0.8125rem] font-normal text-muted-foreground tabular-nums" suppressHydrationWarning>
        Since {personDate(enrollment.enrolledAt, setting, now)} · {paid}
      </span>
      {enrollment.statusChangedAt ? (
        <span className="text-[0.8125rem] font-normal text-muted-foreground" suppressHydrationWarning>
          {CHANGED_VERB[enrollment.status]} {personDate(enrollment.statusChangedAt, setting, now)}
          {/* No changer is recorded for a status carried from the customer row. */}
          {enrollment.statusChangedBy ? ` by ${enrollment.statusChangedBy.name ?? "a removed user"}` : ""}
        </span>
      ) : null}
      {hasPermission("customer:edit") ? (
        <span className="mt-1">
          <EnrollmentStatusControl enrollment={enrollment} />
        </span>
      ) : null}
    </li>
  );
}

/** Notes DM closers wrote in the link portal; the row shows only once there are some. */
function PortalNotesRow() {
  const { lead } = useEntityDetail();
  const { setting } = useBusinessDay();
  const now = useNow();
  const notes = useQuery(api.leads.notes.listLeadNotes, { leadId: lead._id });
  if (!notes || notes.length === 0) return null;
  return (
    <RecordRow label="Portal notes">
      <ol className="flex flex-col gap-2.5">
        {notes.map((note) => (
          <li key={note.noteId} className="flex min-w-0 flex-col gap-0.5">
            <p className="font-normal whitespace-pre-wrap wrap-break-word" translate="no">
              {note.content}
            </p>
            <p className="text-[0.8125rem] font-normal text-muted-foreground" suppressHydrationWarning>
              <span translate="no">{note.authorLabel}</span>
              {note.authorKind === "dm_closer" ? " · DM closer" : ""} ·{" "}
              {personDate(note.createdAt, setting, now)}
            </p>
          </li>
        ))}
      </ol>
    </RecordRow>
  );
}

function StageRow() {
  const { lead } = useEntityDetail();
  const { setting } = useBusinessDay();
  const now = useNow();
  const reached = LIFECYCLE_STAGES.filter((stage) => lead.lifecycleStageEnteredAt[stage] !== undefined);
  return (
    <RecordRow label="Stage">
      {LIFECYCLE_STAGE_LABELS[lead.lifecycleStage]}
      {reached.length > 0 ? (
        <span className="block text-[0.8125rem] font-normal text-muted-foreground tabular-nums" suppressHydrationWarning>
          {reached
            .map(
              (stage) =>
                `${LIFECYCLE_STAGE_LABELS[stage]} ${personDate(lead.lifecycleStageEnteredAt[stage]!, setting, now)}`,
            )
            .join(" · ")}
        </span>
      ) : null}
    </RecordRow>
  );
}

function DispositionRow() {
  const { lead, inactiveAfterDays } = useEntityDetail();
  const { setting } = useBusinessDay();
  const now = useNow();
  const inactiveFor = inactiveDays(lead, inactiveAfterDays, now);
  const source = lead.dispositionSource ? DISPOSITION_SOURCE_LABELS[lead.dispositionSource] : null;
  const note = [
    source && lead.disposition !== "open"
      ? `${source}${lead.dispositionSetAt ? `, ${personDate(lead.dispositionSetAt, setting, now)}` : ""}`
      : null,
    lead.dispositionReason ? `Reason: ${lead.dispositionReason}` : null,
  ].filter((part): part is string => part !== null);

  return (
    <RecordRow label="Disposition">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={lead.disposition === "do_not_contact" ? "text-danger-ink" : undefined}>
          {DISPOSITION_LABELS[lead.disposition]}
        </span>
        {inactiveFor !== null ? (
          <span
            className="inline-flex h-5 items-center rounded-[4px] bg-warning-surface px-1.5 text-xs font-semibold text-warning-ink"
            title={`No touch for ${inactiveAfterDays} days or more`}
            suppressHydrationWarning
          >
            Inactive · {plural(inactiveFor, "day")}
          </span>
        ) : null}
      </span>
      {note.length > 0 ? (
        <span className="block text-[0.8125rem] font-normal text-muted-foreground" suppressHydrationWarning>
          {note.join(" · ")}
        </span>
      ) : null}
    </RecordRow>
  );
}

function LastTouchRow() {
  const { lastTouch } = useEntityDetail();
  const { setting } = useBusinessDay();
  const now = useNow();
  return (
    <RecordRow label="Last touch">
      {lastTouch ? (
        <span suppressHydrationWarning>
          {lastTouch.label}
          <span className="font-normal whitespace-nowrap text-muted-foreground tabular-nums">
            {" · "}
            {personDate(lastTouch.occurredAt, setting, now)}
          </span>
        </span>
      ) : (
        <NotRecorded />
      )}
    </RecordRow>
  );
}
