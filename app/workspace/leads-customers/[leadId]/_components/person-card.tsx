"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useQuery } from "convex/react";
import { useRole } from "@/components/auth/role-context";
import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import type { AttributionTouch } from "@/convex/lib/attribution/detailPayload";
import {
  ENROLLMENT_STATUS_LABELS,
  type EnrollmentStatus,
} from "@/convex/enrollments/validators";
import {
  DISPOSITION_LABELS,
  LIFECYCLE_STAGE_LABELS,
  LIFECYCLE_STAGES,
} from "@/convex/leads/lifecycle";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import { formatCash } from "@/lib/closer-pipeline";
import { cn } from "@/lib/utils";
import { firstNameOf } from "@/app/workspace/closer/meetings/_components/meeting-detail-types";
import {
  DetailCard,
  DetailCardFooter,
} from "@/app/workspace/closer/meetings/_components/detail-card";
import { INITIAL_SOURCE_META } from "@/app/workspace/_components/initial-source-badge";
import { TOUCH_CHANNEL_LABELS } from "@/app/workspace/_components/deal-stage-track";
import { useEntityDetail, type EntityDetailEnrollment } from "./entity-detail-context";
import { EnrollmentStatusControl } from "./enrollment-status-control";
import type { LifecycleChangeMode } from "./lifecycle-change-dialog";
import { contactKey, personDate, plural } from "./person-format";
import { formatPhone } from "@/lib/phone";

const LifecycleChangeDialog = dynamic(() =>
  import("./lifecycle-change-dialog").then((module) => module.LifecycleChangeDialog),
);

const ENROLLMENT_INK: Record<EnrollmentStatus, string> = {
  active: "text-stage-won-ink",
  paused: "text-warning-ink",
  churned: "text-danger-ink",
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

const SMALL_DATE = "font-condensed text-[0.8125rem] font-semibold tracking-[0.02em] text-muted-foreground tabular-nums";

/**
 * The person on one dense card, facts in groups split by a rule: how to
 * reach them, their first and last touch, what the DM portal recorded,
 * their stage and disposition, programs, identifiers that add something,
 * and portal notes. Admins move the stage back or set the disposition from
 * its footer.
 */
export function PersonCard() {
  const { lead, identifiers, enrollments, customerSummary } = useEntityDetail();
  const { isAdmin } = useRole();
  const [mode, setMode] = useState<LifecycleChangeMode | null>(null);
  const handles = lead.socialHandles ?? [];
  const name = lead.fullName ?? lead.email ?? "Unknown person";
  const meta = customerSummary
    ? `Customer · ${ENROLLMENT_STATUS_LABELS[customerSummary.status]}`
    : `Lead · ${DISPOSITION_LABELS[lead.disposition]}`;

  // Identifiers the contact rows don't already show.
  const shown = new Set<string>(
    [lead.email, lead.phone, ...handles.map((handle) => handle.handle)]
      .filter((value): value is string => Boolean(value))
      .map(contactKey),
  );
  const otherIdentifiers = identifiers.filter((identifier) => !shown.has(contactKey(identifier.rawValue)));
  const initialSource = lead.initialSource ? INITIAL_SOURCE_META[lead.initialSource].label : null;
  const income = lead.selfReportedIncome;
  // A customer's stage follows their payments; voiding the payment moves it.
  const canMoveBack = lead.lifecycleStage !== "prospect" && lead.status !== "converted";

  return (
    <DetailCard
      title={<span translate="no">{firstNameOf(lead.fullName) ?? name}</span>}
      meta={<span>{meta}</span>}
    >
      <div className="divide-y [&>dl]:py-1">
        <dl>
        <Fact label="Phone">
          {lead.phone ? (
            <a
              href={`tel:${lead.phone}`}
              className="rounded-sm font-condensed text-[15px] font-semibold tracking-[0.02em] tabular-nums hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              translate="no"
            >
              {formatPhone(lead.phone)}
            </a>
          ) : (
            <Muted>Not recorded</Muted>
          )}
        </Fact>
        <Fact label="Email" title={lead.email ?? undefined}>
          {lead.email ? (
            <a
              href={`mailto:${lead.email}`}
              className="rounded-sm hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              translate="no"
            >
              {lead.email}
            </a>
          ) : (
            <Muted>Not recorded</Muted>
          )}
        </Fact>
        {handles.map((handle) => (
          <Fact key={`${handle.type}:${handle.handle}`} label={socialLabel(handle.type)}>
            <span translate="no">@{handle.handle.replace(/^@/, "")}</span>
          </Fact>
        ))}

        </dl>
        <dl>
          <TouchFacts />
        </dl>

        {initialSource || income !== undefined ? (
          <dl>
            {initialSource ? <Fact label="Initial source">{initialSource}</Fact> : null}
            {income !== undefined ? (
              <Fact label="Income" title="Self-reported in the DM portal">
                <span className="font-condensed text-[15px] font-semibold tabular-nums">
                  {new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(income)}
                </span>{" "}
                <Muted>self-reported</Muted>
              </Fact>
            ) : null}
          </dl>
        ) : null}

        <dl>
          <StageFacts />
        </dl>

        {enrollments.length > 0 ? (
          <dl>
            {enrollments.map((enrollment, index) => (
              <EnrollmentFact
                key={enrollment.enrollmentId}
                enrollment={enrollment}
                label={index === 0 ? (enrollments.length === 1 ? "Program" : "Programs") : ""}
              />
            ))}
          </dl>
        ) : null}

        {otherIdentifiers.length > 0 ? (
          <dl>
            {otherIdentifiers.map((identifier, index) => (
              <Fact key={identifier._id} label={index === 0 ? "Also uses" : ""} title={identifier.rawValue}>
                <span translate="no">{identifier.rawValue}</span>{" "}
                <Muted>
                  {identifier.type === "email"
                    ? "Email"
                    : identifier.type === "phone"
                      ? "Phone"
                      : socialLabel(identifier.type)}
                </Muted>
              </Fact>
            ))}
          </dl>
        ) : null}

        <PortalNotes />
      </div>
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

/** One fact: a 96px muted label beside a one-line value, about 32px tall. */
function Fact({
  label,
  title,
  className,
  children,
}: {
  label: string;
  title?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("grid min-h-8 grid-cols-[6rem_minmax(0,1fr)] items-baseline gap-x-3 px-4 py-1.5", className)}>
      <dt className="text-[0.8125rem] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate" title={title}>
        {children}
      </dd>
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <span className="text-[0.8125rem] text-muted-foreground">{children}</span>;
}

function TouchFacts() {
  const { firstTouch, lastTouch } = useEntityDetail();
  const { setting } = useBusinessDay();
  const now = useNow();
  const touch = (value: AttributionTouch | null) =>
    value ? (
      <>
        <span translate="no">
          {TOUCH_CHANNEL_LABELS[value.channel]}
          {value.teamMemberName ? ` · ${value.teamMemberName}` : ""}
        </span>{" "}
        <span className={SMALL_DATE} suppressHydrationWarning>
          {personDate(value.occurredAt, setting, now)}
        </span>
      </>
    ) : (
      <Muted>Not recorded</Muted>
    );
  return (
    <>
      <Fact label="First touch">{touch(firstTouch)}</Fact>
      <Fact label="Last touch">
        {lastTouch ? (
          <>
            {lastTouch.label}{" "}
            <span className={SMALL_DATE} suppressHydrationWarning>
              {personDate(lastTouch.occurredAt, setting, now)}
            </span>
          </>
        ) : (
          <Muted>Not recorded</Muted>
        )}
      </Fact>
    </>
  );
}

function StageFacts() {
  const { lead } = useEntityDetail();
  const { setting } = useBusinessDay();
  const now = useNow();
  const stage = lead.lifecycleStage;
  const since = lead.lifecycleStageEnteredAt[stage];
  const path = LIFECYCLE_STAGES.filter((option) => lead.lifecycleStageEnteredAt[option] !== undefined)
    .map((option) => `${LIFECYCLE_STAGE_LABELS[option]} ${personDate(lead.lifecycleStageEnteredAt[option]!, setting, now)}`)
    .join(" · ");
  const source = lead.dispositionSource ? DISPOSITION_SOURCE_LABELS[lead.dispositionSource] : null;
  const dispositionNote = [
    lead.disposition !== "open" ? source : null,
    lead.dispositionReason ? `Reason: ${lead.dispositionReason}` : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(". ");

  return (
    <>
      <Fact label="Stage" title={path || undefined}>
        {LIFECYCLE_STAGE_LABELS[stage]}
        {since ? (
          <>
            {" "}
            <Muted>since</Muted>{" "}
            <span className={SMALL_DATE} suppressHydrationWarning>
              {personDate(since, setting, now)}
            </span>
          </>
        ) : null}
      </Fact>
      <Fact label="Disposition" title={dispositionNote || undefined}>
        <span className={lead.disposition === "do_not_contact" ? "text-danger-ink" : undefined}>
          {DISPOSITION_LABELS[lead.disposition]}
        </span>
        {lead.dispositionReason ? (
          <>
            {" "}
            <Muted>· {lead.dispositionReason}</Muted>
          </>
        ) : null}
      </Fact>
    </>
  );
}

function EnrollmentFact({ enrollment, label }: { enrollment: EntityDetailEnrollment; label: string }) {
  const { setting } = useBusinessDay();
  const { hasPermission } = useRole();
  const now = useNow();
  const paid =
    enrollment.totalPaidMinor !== null && enrollment.currency
      ? formatCash(enrollment.totalPaidMinor, enrollment.currency)
      : plural(enrollment.paymentCount, "payment");
  const canEdit = hasPermission("customer:edit");
  return (
    <div className="grid min-h-8 grid-cols-[6rem_minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-1">
      <dt className="self-baseline pt-0.5 text-[0.8125rem] text-muted-foreground">{label}</dt>
      <dd className="min-w-0">
        <p className="truncate" title={enrollment.programName}>
          <span translate="no">{enrollment.programName}</span>{" "}
          {canEdit ? null : (
            <span
              className={cn(
                "font-condensed text-[13px] font-bold tracking-[0.08em] uppercase",
                ENROLLMENT_INK[enrollment.status],
              )}
            >
              {ENROLLMENT_STATUS_LABELS[enrollment.status]}
            </span>
          )}
        </p>
        <p
          className={cn(SMALL_DATE, "truncate")}
          title={`Enrolled ${personDate(enrollment.enrolledAt, setting, now)} · ${paid}`}
          suppressHydrationWarning
        >
          {paid} · {personDate(enrollment.enrolledAt, setting, now)}
        </p>
      </dd>
      <dd>{canEdit ? <EnrollmentStatusControl enrollment={enrollment} /> : null}</dd>
    </div>
  );
}

/** Notes DM closers wrote in the link portal; shown only once there are some. */
function PortalNotes() {
  const { lead } = useEntityDetail();
  const { setting } = useBusinessDay();
  const now = useNow();
  const notes = useQuery(api.leads.notes.listLeadNotes, { leadId: lead._id });
  if (!notes || notes.length === 0) return null;
  return (
    <dl>
      <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 px-4 py-1.5">
        <dt className="text-[0.8125rem] text-muted-foreground">Portal notes</dt>
        <dd className="flex min-w-0 flex-col gap-2">
          {notes.map((note) => (
            <p key={note.noteId} className="text-[0.8125rem] whitespace-pre-wrap wrap-break-word" translate="no">
                {note.content}
                <span className="block text-muted-foreground" suppressHydrationWarning>
                  <span translate="no">{note.authorLabel}</span>
                  {note.authorKind === "dm_closer" ? " · DM closer" : ""} ·{" "}
                  {personDate(note.createdAt, setting, now)}
                </span>
            </p>
          ))}
        </dd>
      </div>
    </dl>
  );
}
