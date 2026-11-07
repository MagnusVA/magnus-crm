"use client";

import { Component, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { UserPlusIcon } from "lucide-react";
import { RequirePermission } from "@/components/auth/require-permission";
import { Button } from "@/components/ui/button";
import { formatHours } from "../schedule-editor";
import { activeHours, memberStatus } from "../members/members-model";
import { BandFigure, BandFigures, BandFiguresPlaceholder } from "./band-figure";

// Team › Members: the band's figures and its one lime action. The band
// (../team-band.tsx) renders these on the Members tab.

const INVITE_BUTTON = (
  <Button className="self-start">
    <UserPlusIcon data-icon="inline-start" aria-hidden />
    Invite to CRM
  </Button>
);

// The dialog loads lazily; the same button stands in while its code loads.
const InviteUserDialog = dynamic(
  () => import("../invite-user-dialog").then((m) => ({ default: m.InviteUserDialog })),
  { loading: () => INVITE_BUTTON },
);

/** Team members, hours a week, no login, and what Review has to decide. */
export function MembersFigures() {
  const directory = useQuery(api.team.directory.getDirectory, {});
  if (!directory) return <BandFiguresPlaceholder />;
  const members = directory.members;
  const active = members.filter((member) => memberStatus(member) === "Active");
  const hours = members.reduce((sum, member) => sum + activeHours(member), 0);
  const onSchedule = members.filter((member) => activeHours(member) > 0).length;
  const noLogin = members.filter((member) => member.login === null).length;
  return (
    <BandFigures>
      <BandFigure
        label="Team members"
        tip="Humans, not records: someone with a CRM login, a lead gen record and a DM closer record is one team member. Active while any of their records is."
        value={active.length}
        caption={`${members.length - active.length} inactive or invited`}
      />
      <BandFigure
        label="Hours a week"
        tip="Every active role’s week in force today, added up. Someone with two roles counts each role’s week."
        value={formatHours(hours)}
        unit="h"
        caption={`${onSchedule} ${onSchedule === 1 ? "person" : "people"} on a schedule`}
      />
      <BandFigure
        label="No login"
        tip="Team members with no CRM login: DM closers and Slack-only qualifiers. They get credit without signing in to Magnus."
        value={noLogin}
        caption="DM closers and Slack-only"
      />
      <ReviewBoundary>
        <ToDecide />
      </ReviewBoundary>
    </BandFigures>
  );
}

const TO_DECIDE_TIP =
  "Records that may be one human, Slack users linked to nobody, and teams that disagree between roles. Decide each one on Review.";

function ToDecide() {
  const review = useQuery(api.team.review.listReviewItems, {});
  const count = review?.count;
  return (
    <BandFigure
      label="To decide"
      tip={TO_DECIDE_TIP}
      value={count ?? "—"}
      caption="Open Review"
      href="/workspace/team/review"
      tone={count ? "warning" : "default"}
    />
  );
}

/** Review can refuse a workspace too large to compare; the figure then reads "—" and the band carries on. */
class ReviewBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return <BandFigure label="To decide" tip={TO_DECIDE_TIP} value="—" caption="Open Review" href="/workspace/team/review" />;
  }
}

/** The Members tab's lime action: invite someone to the CRM. */
export function MembersAction() {
  return (
    <RequirePermission permission="team:invite">
      <InviteUserDialog trigger={INVITE_BUTTON} />
    </RequirePermission>
  );
}
