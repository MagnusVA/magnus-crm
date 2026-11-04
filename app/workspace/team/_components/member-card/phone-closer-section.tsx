"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useRole } from "@/components/auth/role-context";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { firstName } from "../team-ui";
import { RecentReassignments } from "../recent-reassignments";
import { CardSection, RecordRow, RuledBlock } from "./card-ui";
import type { DirectoryMember } from "./member-model";

const CalendlyLinkDialog = dynamic(() => import("../calendly-link-dialog").then((module) => ({ default: module.CalendlyLinkDialog })));
const EventTypeAssignmentDialog = dynamic(() =>
  import("../event-type-assignment-dialog").then((module) => ({ default: module.EventTypeAssignmentDialog })),
);
const MarkUnavailableDialog = dynamic(() =>
  import("../mark-unavailable-dialog").then((module) => ({ default: module.MarkUnavailableDialog })),
);

type Open = null | "calendly" | "event-type" | "unavailable";

/**
 * A phone closer's Calendly side: the Calendly member their round-robin
 * bookings land on, their personal event type for follow-ups, marking them
 * unavailable (which leads to redistributing their calls), and recent
 * reassignments. The old Team page's rules: actions only while the login is
 * active; event type and availability need their permissions.
 */
export function PhoneCloserSection({ member }: { member: DirectoryMember }) {
  const login = member.login!;
  const { hasPermission } = useRole();
  const users = useQuery(api.users.queries.listTeamMembers, {});
  const user = users?.find((row) => row._id === login.userId);
  const [open, setOpen] = useState<Open>(null);
  const first = firstName(member.name);
  const active = login.isActive && !login.removed;
  const name = user ? user.fullName || user.email : member.name;

  return (
    <CardSection title="Phone closer" meta={active ? "Takes Calendly bookings" : "Login deactivated"}>
      <div className="flex flex-col gap-3.5">
        <RuledBlock>
          {user === undefined ? (
            <div role="status" aria-label="Loading Calendly details" className="flex flex-col gap-2 p-3">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (
            <>
              <RecordRow
                label="Calendly member"
                tip="The Calendly account their bookings land on. Round-robin bookings for this member are assigned to them."
                primary={
                  user.calendlyUserUri ? (
                    <span className="font-medium">{user.calendlyMemberName ?? "Linked"}</span>
                  ) : (
                    <span className="font-medium text-warning-ink">Not linked</span>
                  )
                }
                secondary={
                  user.calendlyUserUri ? `Round-robin bookings land on ${first}` : `Bookings can’t reach ${first} until this is linked`
                }
                actions={
                  active ? (
                    <Button variant="outline" size="sm" onClick={() => setOpen("calendly")}>
                      {user.calendlyUserUri ? "Re-link" : "Link Calendly"}
                    </Button>
                  ) : null
                }
              />
              <RecordRow
                label="Personal event type"
                tip="Their own Calendly booking page. Follow-up scheduling links send leads here."
                primary={
                  user.personalEventTypeUri ? (
                    <span className="font-mono text-[13px] tracking-[-0.01em] break-all" translate="no">
                      {user.personalEventTypeUri.replace(/^https?:\/\//, "")}
                    </span>
                  ) : (
                    <span className="font-medium text-warning-ink">Not assigned</span>
                  )
                }
                secondary="Follow-up scheduling links"
                actions={
                  active && hasPermission("team:assign-event-type") ? (
                    <Button variant="outline" size="sm" onClick={() => setOpen("event-type")}>
                      {user.personalEventTypeUri ? "Change" : "Assign"}
                    </Button>
                  ) : null
                }
              />
              <RecordRow
                label="Availability"
                tip="Mark them unavailable for a day or some hours when they're out; you then choose who takes their calls."
                primary={active ? "Takes calls" : "Deactivated"}
                secondary={active ? "Mark a day or some hours off, then redistribute their calls" : undefined}
                actions={
                  active && hasPermission("team:manage-availability") ? (
                    <Button variant="outline" size="sm" onClick={() => setOpen("unavailable")}>
                      Mark unavailable
                    </Button>
                  ) : null
                }
              />
            </>
          )}
        </RuledBlock>
        <RecentReassignments closerId={login.userId} />
      </div>

      {user && open === "calendly" ? (
        <CalendlyLinkDialog
          open
          onOpenChange={(next) => !next && setOpen(null)}
          userId={user._id}
          userName={name}
          userIdentity={user.avatar}
        />
      ) : null}
      {user && open === "event-type" ? (
        <EventTypeAssignmentDialog
          open
          onOpenChange={(next) => !next && setOpen(null)}
          userId={user._id}
          userName={name}
          userIdentity={user.avatar}
          currentUri={user.personalEventTypeUri}
        />
      ) : null}
      {user && open === "unavailable" ? (
        <MarkUnavailableDialog
          open
          onOpenChange={(next) => !next && setOpen(null)}
          userId={user._id}
          userName={name}
          userIdentity={user.avatar}
        />
      ) : null}
    </CardSection>
  );
}
