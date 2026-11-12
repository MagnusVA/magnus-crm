"use client";

import { useState } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { ItemKind } from "@/lib/callInsights/taxonomy";
import {
  costLabel,
  goalLine,
  incomeLine,
  modelLabel,
  notReadReason,
  quoteLine,
  resolutionWord,
} from "@/lib/callInsights/display";
import { getErrorMessage } from "@/lib/errors";
import { useRole } from "@/components/auth/role-context";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DetailCard,
  DetailCardFooter,
} from "@/app/workspace/closer/meetings/_components/detail-card";
import { Chip, GroupLabel, ItemRow, QuoteText } from "./item-rows";

type MeetingInsights = NonNullable<
  FunctionReturnType<typeof api.callInsights.queries.forMeeting>
>;
type Item = MeetingInsights["items"][number];
type Admin = NonNullable<MeetingInsights["admin"]>;
type Rejected = Admin["rejected"][number];

const QUOTE_DELETED =
  "Quote deleted with the transcript. The category and result stay.";

const GROUPS: { kind: ItemKind; label: string }[] = [
  { kind: "objection", label: "Objections" },
  { kind: "struggle", label: "Struggles" },
  { kind: "goal", label: "Goals" },
  { kind: "income", label: "Income" },
];

/**
 * What the prospect said on this call, read from the recording: objections,
 * struggles, goals and income, each opening to its statement and quote.
 * Renders nothing until there is something to say for this viewer: the query
 * returns null when the feature is off or the viewer may not see it.
 * Prospect words sit under `ph-no-capture` so session replay never records them.
 */
export function WhatTheySaidCard({ meetingId }: { meetingId: Id<"meetings"> }) {
  const { isAuthenticated } = useConvexAuth();
  const data = useQuery(
    api.callInsights.queries.forMeeting,
    isAuthenticated ? { meetingId } : "skip",
  );
  const { isAdmin } = useRole();
  if (!data || data.state === "none") return null;

  if (
    data.state === "queued" ||
    data.state === "reading" ||
    data.state === "waiting"
  ) {
    const waiting = data.state === "waiting" && isAdmin;
    return (
      <DetailCard title="What they said">
        <div className="flex flex-col gap-2 p-4" role="status">
          <p className="text-sm text-muted-foreground">
            {waiting
              ? "Waiting for room under this month's limit."
              : "Reading the call…"}
          </p>
          {waiting ? null : (
            <>
              <Skeleton className="h-3 w-4/5" />
              <Skeleton className="h-3 w-[62%]" />
            </>
          )}
        </div>
        {data.admin ? <AdminFooter admin={data.admin} /> : null}
      </DetailCard>
    );
  }

  if (data.state === "not_read") {
    if (!isAdmin) return null;
    return (
      <DetailCard title="What they said" badge={<Chip>Not read</Chip>}>
        <p className="p-4 text-sm text-muted-foreground">
          {notReadReason(data.reason)}
        </p>
        <AdminFooter admin={data.admin} />
      </DetailCard>
    );
  }

  const groups = GROUPS.map((group) => ({
    ...group,
    items: data.items.filter((item) => item.kind === group.kind),
  })).filter((group) => group.items.length > 0);

  return (
    <DetailCard title="What they said" className="ph-no-capture">
      {data.rereading ? (
        <p className="border-b px-4 py-2 text-[0.8125rem] text-muted-foreground">
          Reading again. This result stays until the new one is saved.
        </p>
      ) : null}
      {data.speakerUncertain ? (
        <p className="border-b px-4 py-2 text-[0.8125rem] text-muted-foreground">
          The recording doesn&apos;t make clear who is speaking, so treat this
          with care.
        </p>
      ) : null}
      {groups.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">
          {data.readKind === "attendance_only"
            ? "Only the closer is heard on this recording, so there is nothing to list."
            : "The prospect didn't state an objection, a struggle, a goal or an income on this call."}
        </p>
      ) : (
        groups.map((group) => (
          <section key={group.kind} aria-label={group.label}>
            <GroupLabel>{group.label}</GroupLabel>
            <ul>
              {group.items.map((item) => (
                <InsightRow key={item.key} item={item} />
              ))}
            </ul>
          </section>
        ))
      )}
      {data.admin ? (
        <>
          <RejectedItems meetingId={meetingId} admin={data.admin} />
          <AdminFooter admin={data.admin} />
        </>
      ) : null}
    </DetailCard>
  );
}

function InsightRow({ item }: { item: Item }) {
  const summary =
    item.kind === "income"
      ? incomeLine(item)
      : item.kind === "goal"
        ? goalLine(item)
        : item.label;
  const resolution =
    item.kind === "objection" ? resolutionWord(item.resolution) : null;
  return (
    <ItemRow
      summary={<span className="font-medium">{summary}</span>}
      chips={
        <>
          {item.isPrimary ? <Chip tone="ink">Main</Chip> : null}
          {item.check === "unsure" ? <Chip>Not confirmed</Chip> : null}
        </>
      }
      trailing={
        resolution ? (
          <span
            className={
              resolution === "Open"
                ? "font-condensed text-[0.875rem] font-semibold tracking-[0.02em]"
                : "font-condensed text-[0.875rem] font-semibold tracking-[0.02em] text-muted-foreground"
            }
          >
            {resolution}
          </span>
        ) : null
      }
    >
      {item.statement ? <p>{item.statement}</p> : null}
      <QuoteText
        line={item.quote === null ? null : quoteLine(item.at, item.quote)}
        deleted={QUOTE_DELETED}
      />
      {item.resolution === "resolved" && item.resolutionQuote ? (
        <p className="text-muted-foreground">
          Resolved: &ldquo;{item.resolutionQuote}&rdquo;
        </p>
      ) : null}
    </ItemRow>
  );
}

/** The admin's foot of the card: model and cost, and Read again. */
function AdminFooter({ admin }: { admin: Admin | undefined }) {
  if (!admin) return null;
  return (
    <DetailCardFooter className="font-normal">
      <span className="text-[0.8125rem]">
        {modelLabel(admin.model)} · {costLabel(admin.costUsd)}
      </span>
      {admin.canReadAgain ? (
        <ReadAgainButton recordingId={admin.recordingId} />
      ) : null}
    </DetailCardFooter>
  );
}

function ReadAgainButton({
  recordingId,
}: {
  recordingId: Id<"callRecordings">;
}) {
  const readAgain = useMutation(api.callInsights.admin.readAgain);
  const [pending, setPending] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        try {
          const runId = await readAgain({ recordingId });
          if (runId) toast.success("Reading the call again.");
          else toast.error("This call can't be read again right now.");
        } catch (error) {
          toast.error(getErrorMessage(error, "Couldn't read the call again."));
        } finally {
          setPending(false);
        }
      }}
    >
      {pending ? "Starting…" : "Read again"}
    </Button>
  );
}

/** Items Jev's check hid, for an admin to show or leave hidden. */
function RejectedItems({
  meetingId,
  admin,
}: {
  meetingId: Id<"meetings">;
  admin: Admin;
}) {
  if (admin.rejected.length === 0) return null;
  const runId = admin.runId;
  return (
    <Collapsible className="border-t">
      <CollapsibleTrigger className="flex min-h-10 w-full items-center px-4 py-2 text-left text-[0.8125rem] font-medium text-muted-foreground transition-colors outline-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/60 focus-visible:ring-inset">
        Hidden after Jev&apos;s check ({admin.rejected.length})
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="border-t">
          {admin.rejected.map((item) => (
            <RejectedRow
              key={`${meetingId}:${item.key}`}
              item={item}
              runId={runId}
            />
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

const REVIEW_STATE_WORDS: Record<Rejected["reviewState"], string | null> = {
  open: null,
  restored: "Shown",
  dismissed: "Left hidden",
  superseded: "Replaced by a newer reading",
};

function RejectedRow({
  item,
  runId,
}: {
  item: Rejected;
  runId: Id<"callInsightRuns"> | undefined;
}) {
  const reviewItem = useMutation(api.callInsights.admin.reviewItem);
  const [pending, setPending] = useState<"restore" | "dismiss" | null>(null);
  const decide = async (decision: "restore" | "dismiss") => {
    if (!runId) return;
    setPending(decision);
    try {
      await reviewItem({ runId, itemKey: item.key, decision });
    } catch (error) {
      toast.error(getErrorMessage(error, "Couldn't save the decision."));
    } finally {
      setPending(null);
    }
  };
  const stateWord = REVIEW_STATE_WORDS[item.reviewState];
  return (
    <li className="flex flex-col gap-1 border-b px-4 py-2.5 text-[0.8125rem] leading-[1.45] text-foreground last:border-b-0">
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{item.label}</span>
        {stateWord ? <Chip>{stateWord}</Chip> : null}
      </p>
      {item.statement ? <p>{item.statement}</p> : null}
      <QuoteText
        line={item.quote === null ? null : `“${item.quote}”`}
        deleted={QUOTE_DELETED}
      />
      {runId && item.reviewState === "open" ? (
        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            size="sm"
            variant="outline"
            disabled={pending !== null}
            onClick={() => void decide("restore")}
          >
            {pending === "restore" ? "Showing…" : "Show it"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending !== null}
            onClick={() => void decide("dismiss")}
          >
            {pending === "dismiss" ? "Saving…" : "Leave hidden"}
          </Button>
        </div>
      ) : null}
    </li>
  );
}
