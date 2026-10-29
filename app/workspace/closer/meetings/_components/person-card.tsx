"use client";

import { useState } from "react";
import Link from "next/link";
import { CheckIcon } from "lucide-react";
import { toast } from "sonner";
import {
  DISPOSITION_LABELS,
  LIFECYCLE_STAGE_LABELS,
} from "@/convex/leads/lifecycle";
import { Button } from "@/components/ui/button";
import { DetailCard, DetailCardFooter, detailLinkClass } from "./detail-card";
import type { MeetingDetail } from "./meeting-detail-types";

type ContactRow = {
  label: string;
  value: string | null;
  href: string | null;
};

function instagramHandleOf(lead: MeetingDetail["lead"]): string | null {
  const handle = lead.socialHandles?.find(
    (social) => social.type.toLowerCase() === "instagram",
  )?.handle;
  return handle ? handle.replace(/^@/, "") : null;
}

/**
 * The person on the call: how to reach them, each value one click from the
 * clipboard, and their other meetings on the person page. The person page
 * lists every meeting by deal, so this card doesn't repeat that history.
 */
export function PersonCard({ detail }: { detail: MeetingDetail }) {
  const { lead, meeting, meetingHistory } = detail;
  const instagram = instagramHandleOf(lead);
  const rows: ContactRow[] = [
    {
      label: "Email",
      value: lead.email ?? null,
      href: lead.email ? `mailto:${lead.email}` : null,
    },
    {
      label: "Phone",
      value: lead.phone ?? null,
      href: lead.phone ? `tel:${lead.phone}` : null,
    },
    {
      label: "Instagram",
      value: instagram ? `@${instagram}` : null,
      href: instagram ? `https://instagram.com/${encodeURIComponent(instagram)}` : null,
    },
  ];

  const others = meetingHistory.filter((entry) => !entry.isCurrentMeeting);
  const earlier = others.filter((entry) => entry.scheduledAt < meeting.scheduledAt);
  const later = others.length - earlier.length;
  const historyLine =
    others.length === 0
      ? "No other meetings"
      : [
          earlier.length > 0
            ? `${earlier.length} earlier meeting${earlier.length === 1 ? "" : "s"}`
            : null,
          later > 0 ? `${later} later` : null,
        ]
          .filter(Boolean)
          .join(" · ");

  return (
    <DetailCard
      title={lead.fullName ?? lead.email ?? "Person"}
      meta={
        <span>
          {LIFECYCLE_STAGE_LABELS[lead.lifecycleStage]} ·{" "}
          {DISPOSITION_LABELS[lead.disposition]}
        </span>
      }
    >
      <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-2 px-4 py-3">
        {rows.map((row) => (
          <div key={row.label} className="contents">
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="min-w-0 truncate font-medium" title={row.value ?? undefined}>
              {row.value && row.href ? (
                <a
                  href={row.href}
                  target={row.label === "Instagram" ? "_blank" : undefined}
                  rel={row.label === "Instagram" ? "noopener noreferrer" : undefined}
                  className="rounded-sm hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  {row.value}
                </a>
              ) : (
                <span className="font-normal text-muted-foreground">Not recorded</span>
              )}
            </dd>
            <dd>
              {row.value ? (
                <CopyValueButton value={row.value} label={row.label} />
              ) : null}
            </dd>
          </div>
        ))}
      </dl>

      <DetailCardFooter>
        <span>{historyLine}</span>
        <Link href={`/workspace/leads-customers/${lead._id}`} className={detailLinkClass}>
          Person page
        </Link>
      </DetailCardFooter>
    </DetailCard>
  );
}

function CopyValueButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      aria-label={copied ? `${label} copied` : `Copy ${label.toLowerCase()}`}
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        toast.success(`${label} copied`);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? <CheckIcon data-icon="inline-start" aria-hidden /> : null}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}
