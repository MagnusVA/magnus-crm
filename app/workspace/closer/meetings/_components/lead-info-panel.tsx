"use client";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { UserIcon, MailIcon, PhoneIcon } from "lucide-react";
import { MeetingHistoryTimeline } from "./meeting-history-timeline";
import type { Doc } from "@/convex/_generated/dataModel";

type LeadInfoPanelProps = {
  lead: Doc<"leads">;
  meetingHistory: Array<
    Doc<"meetings"> & {
      opportunityStatus: Doc<"opportunities">["status"];
      isCurrentMeeting: boolean;
    }
  >;
  meetingDetailBasePath?: string;
};

/**
 * Lead Info Panel — left sidebar on the meeting detail page.
 *
 * Displays the lead's contact information (name, email, phone) and a
 * vertical timeline of all their meetings across all opportunities via
 * the extracted `MeetingHistoryTimeline` component.
 */
export function LeadInfoPanel({
  lead,
  meetingHistory,
  meetingDetailBasePath,
}: LeadInfoPanelProps) {
  return (
    <div className="flex flex-col gap-4">
      {/* Lead Profile */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Lead Information</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {lead.fullName && (
            <ContactRow
              icon={<UserIcon />}
              bgClass="bg-primary/10"
              iconClass="text-primary"
              label="Name"
            >
              <p className="truncate text-sm font-semibold">{lead.fullName}</p>
            </ContactRow>
          )}

          <ContactRow
            icon={<MailIcon />}
            bgClass="bg-primary/10"
            iconClass="text-primary"
            label="Email"
          >
            <a
              href={`mailto:${lead.email}`}
              className="truncate text-sm text-primary hover:underline"
            >
              {lead.email}
            </a>
          </ContactRow>

          {lead.phone && (
            <ContactRow
              icon={<PhoneIcon />}
              bgClass="bg-primary/10"
              iconClass="text-primary"
              label="Phone"
            >
              <a
                href={`tel:${lead.phone}`}
                className="truncate text-sm text-primary hover:underline"
              >
                {lead.phone}
              </a>
            </ContactRow>
          )}
        </CardContent>
      </Card>

      {/* Meeting History */}
      {meetingHistory.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Meeting History</CardTitle>
          </CardHeader>
          <CardContent>
            <MeetingHistoryTimeline
              meetingHistory={meetingHistory}
              meetingDetailBasePath={meetingDetailBasePath}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Internal ────────────────────────────────────────────────────────────────

function ContactRow({
  icon,
  bgClass,
  iconClass,
  label,
  children,
}: {
  icon: React.ReactNode;
  bgClass: string;
  iconClass: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3">
      <div
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-lg [&>svg]:size-4",
          bgClass,
          iconClass,
        )}
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        {children}
      </div>
    </div>
  );
}
