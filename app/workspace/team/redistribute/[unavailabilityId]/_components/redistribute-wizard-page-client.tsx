"use client";

import { useCallback, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { usePageTitle } from "@/hooks/use-page-title";
import { useBreadcrumbTrail } from "@/hooks/use-breadcrumbs";
import { useRole } from "@/components/auth/role-context";
import { Button } from "@/components/ui/button";
import { PageBand } from "@/app/workspace/_components/page-band";
import { CARD, CardHead, HelpTip } from "@/app/workspace/team/_components/team-ui";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { getErrorMessage } from "@/lib/errors";
import { DistributeStep } from "./distribute-step";
import { DoneStep } from "./done-step";
import {
  CardFooter,
  REDISTRIBUTE_ROOT,
  RedistributeSkeleton,
  StepTabs,
  dayAndHours,
  formatDay,
  formatHours,
  offPhrase,
  possessive,
  type Unavailability,
  type WizardStep,
} from "./redistribute-ui";
import { ResolveStep } from "./resolve-step";
import { ReviewStep } from "./review-step";

// The confirmations load lazily; nothing stands in, since they open on a click.
const MoveCallsDialog = dynamic(() => import("./confirm-dialogs").then((m) => ({ default: m.MoveCallsDialog })));
const CancelCallDialog = dynamic(() => import("./confirm-dialogs").then((m) => ({ default: m.CancelCallDialog })));

interface RedistributeWizardProps {
  unavailabilityId: Id<"closerUnavailability">;
}

// Matches the return type of autoDistributeMeetings
interface DistributionResult {
  assigned: Array<{
    meetingId: Id<"meetings">;
    toCloserId: Id<"users">;
    toCloserName: string;
  }>;
  unassigned: Array<{
    meetingId: Id<"meetings">;
    reason: string;
  }>;
}

const TEAM_HREF = "/workspace/team";

/** A note this short reads in the band; a longer one goes behind a HelpTip. */
const NOTE_IN_LINE = 40;

// ─── Main Component ─────────────────────────────────────────────────

export function RedistributeWizardPageClient({ unavailabilityId }: RedistributeWizardProps) {
  usePageTitle("Redistribute calls");
  const router = useRouter();
  const { isAdmin } = useRole();

  // ── Wizard state ──
  const [step, setStep] = useState<WizardStep>("review");
  const [selectedMeetingIds, setSelectedMeetingIds] = useState<Set<Id<"meetings">>>(new Set());
  const [selectedCloserIds, setSelectedCloserIds] = useState<Set<Id<"users">>>(new Set());
  const [isDistributing, setIsDistributing] = useState(false);
  const [distributionResult, setDistributionResult] = useState<DistributionResult | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);

  // ── Resolve step state ──
  const [currentResolveIndex, setCurrentResolveIndex] = useState(0);
  const [resolveCloserId, setResolveCloserId] = useState<string>("");
  const [resolving, setResolving] = useState<"assign" | "cancel" | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  // For the Done card: who took the calls assigned by hand, and how many were canceled.
  const [manualAssignees, setManualAssignees] = useState<string[]>([]);
  const [canceledCount, setCanceledCount] = useState(0);

  // ── Queries ──
  const data = useQuery(api.unavailability.queries.getUnavailabilityWithMeetings, { unavailabilityId });

  const availableClosers = useQuery(
    api.unavailability.queries.getAvailableClosersForDate,
    data
      ? {
          date: data.unavailability.date,
          excludeCloserId: data.unavailability.closerId as Id<"users">,
        }
      : "skip",
  );

  // ── Mutations ──
  const autoDistribute = useMutation(api.unavailability.redistribution.autoDistributeMeetings);
  const manuallyResolve = useMutation(api.unavailability.redistribution.manuallyResolveMeeting);

  // "Home › Team › Redistribute · Marcus Bell"; the path alone has only an ID.
  const closerName = data?.unavailability.closerName;
  useBreadcrumbTrail([
    { label: "Home", href: "/workspace" },
    { label: "Team", href: TEAM_HREF },
    {
      label: closerName ? `Redistribute · ${closerName}` : "Redistribute",
      href: `/workspace/team/redistribute/${unavailabilityId}`,
    },
  ]);

  // ── Derived data ──
  const meetings = useMemo(() => data?.affectedMeetings ?? [], [data]);
  const pendingMeetings = useMemo(() => meetings.filter((m) => !m.alreadyReassigned), [meetings]);
  const sortedMeetings = useMemo(() => [...meetings].sort((a, b) => a.scheduledAt - b.scheduledAt), [meetings]);

  const typedClosers = useMemo(() => availableClosers ?? [], [availableClosers]);
  const enabledClosers = useMemo(() => typedClosers.filter((c) => c.isAvailable), [typedClosers]);

  // ── Meeting selection handlers ──
  const toggleMeeting = useCallback((meetingId: Id<"meetings">) => {
    setSelectedMeetingIds((prev) => {
      const next = new Set(prev);
      if (next.has(meetingId)) {
        next.delete(meetingId);
      } else {
        next.add(meetingId);
      }
      return next;
    });
  }, []);

  const toggleAllMeetings = useCallback(() => {
    setSelectedMeetingIds((prev) => {
      if (prev.size === pendingMeetings.length) {
        return new Set();
      }
      return new Set(pendingMeetings.map((m) => m.meetingId));
    });
  }, [pendingMeetings]);

  // ── Closer selection handlers ──
  const toggleCloser = useCallback(
    (closerId: Id<"users">) => {
      const closer = typedClosers.find((c) => c.closerId === closerId);
      if (!closer?.isAvailable) return;
      setSelectedCloserIds((prev) => {
        const next = new Set(prev);
        if (next.has(closerId)) {
          next.delete(closerId);
        } else {
          next.add(closerId);
        }
        return next;
      });
    },
    [typedClosers],
  );

  const toggleAllClosers = useCallback(() => {
    setSelectedCloserIds((prev) =>
      prev.size === enabledClosers.length ? new Set() : new Set(enabledClosers.map((c) => c.closerId)),
    );
  }, [enabledClosers]);

  // ── Auto-distribute handler (run from the confirmation; false keeps it open) ──
  const handleAutoDistribute = useCallback(async (): Promise<boolean> => {
    if (selectedMeetingIds.size === 0 || selectedCloserIds.size === 0) return false;
    setIsDistributing(true);
    try {
      const result = await autoDistribute({
        unavailabilityId,
        meetingIds: Array.from(selectedMeetingIds),
        candidateCloserIds: Array.from(selectedCloserIds),
      });
      setDistributionResult(result);
      if (result.unassigned.length === 0) {
        setStep("complete");
        toast.success(
          `Successfully redistributed ${result.assigned.length} meeting${result.assigned.length === 1 ? "" : "s"}`,
        );
      } else {
        setCurrentResolveIndex(0);
        setResolveCloserId("");
        setStep("resolve");
        toast.info(
          `${result.assigned.length} meeting${result.assigned.length === 1 ? "" : "s"} assigned. ${result.unassigned.length} need${result.unassigned.length === 1 ? "s" : ""} manual resolution.`,
        );
      }
      return true;
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to distribute meetings"));
      return false;
    } finally {
      setIsDistributing(false);
    }
  }, [selectedMeetingIds, selectedCloserIds, unavailabilityId, autoDistribute]);

  // ── Manual resolve handlers ──
  const unassignedMeetings = useMemo(() => {
    if (!distributionResult) return [];
    const unassignedIds = new Set(distributionResult.unassigned.map((u) => u.meetingId));
    return sortedMeetings.filter((m) => unassignedIds.has(m.meetingId));
  }, [distributionResult, sortedMeetings]);

  const currentUnassigned = unassignedMeetings[currentResolveIndex] ?? null;

  const handleForceAssign = useCallback(async () => {
    if (!currentUnassigned || !resolveCloserId) return;
    setResolving("assign");
    try {
      await manuallyResolve({
        unavailabilityId,
        meetingId: currentUnassigned.meetingId,
        targetCloserId: resolveCloserId as Id<"users">,
        action: "assign",
      });
      const assignee = enabledClosers.find((c) => c.closerId === resolveCloserId)?.closerName;
      if (assignee) setManualAssignees((prev) => [...prev, assignee]);
      const nextIndex = currentResolveIndex + 1;
      if (nextIndex >= unassignedMeetings.length) {
        setStep("complete");
        toast.success("All meetings have been resolved");
      } else {
        setCurrentResolveIndex(nextIndex);
        setResolveCloserId("");
      }
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to assign meeting"));
    } finally {
      setResolving(null);
    }
  }, [
    currentUnassigned,
    resolveCloserId,
    unavailabilityId,
    manuallyResolve,
    currentResolveIndex,
    unassignedMeetings.length,
    enabledClosers,
  ]);

  // Run from the confirmation; false keeps it open.
  const handleCancelMeeting = useCallback(async (): Promise<boolean> => {
    if (!currentUnassigned) return false;
    setResolving("cancel");
    try {
      await manuallyResolve({
        unavailabilityId,
        meetingId: currentUnassigned.meetingId,
        action: "cancel",
      });
      setCanceledCount((count) => count + 1);
      const nextIndex = currentResolveIndex + 1;
      if (nextIndex >= unassignedMeetings.length) {
        setStep("complete");
        toast.success("All meetings have been resolved");
      } else {
        setCurrentResolveIndex(nextIndex);
        setResolveCloserId("");
      }
      return true;
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to cancel meeting"));
      return false;
    } finally {
      setResolving(null);
    }
  }, [currentUnassigned, unavailabilityId, manuallyResolve, currentResolveIndex, unassignedMeetings.length]);

  // ── Who took the calls, for the Done card ──
  const movedTo = useMemo(() => {
    const counts = new Map<string, number>();
    for (const name of [...(distributionResult?.assigned.map((a) => a.toCloserName) ?? []), ...manualAssignees]) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [distributionResult, manualAssignees]);

  const backToTeam = useCallback(() => router.push(TEAM_HREF), [router]);

  // ── Guard: loading or unauthorized ──
  if (!isAdmin) {
    return <RedistributeSkeleton />;
  }

  if (data === undefined) {
    return <RedistributeSkeleton />;
  }

  if (data === null) {
    return (
      <div className={REDISTRIBUTE_ROOT}>
        <PageBand
          back={{ href: TEAM_HREF, label: "Team" }}
          title="Redistribute calls"
          description="This day off wasn't found, or you can't see it."
        />
        <section className={CARD}>
          <CardHead title="Nothing to redistribute" />
          <SectionEmpty title="The record may have been removed.">Mark the closer unavailable again from Team.</SectionEmpty>
          <CardFooter>
            <Button onClick={backToTeam} className="font-semibold">
              Back to Team
            </Button>
          </CardFooter>
        </section>
      </div>
    );
  }

  const { unavailability } = data;
  const name = unavailability.closerName;
  const selectedCalls = sortedMeetings.filter((m) => selectedMeetingIds.has(m.meetingId));
  const chosenNames = enabledClosers.filter((c) => selectedCloserIds.has(c.closerId)).map((c) => c.closerName);
  const resolveReason = currentUnassigned
    ? distributionResult?.unassigned.find((u) => u.meetingId === currentUnassigned.meetingId)?.reason
    : undefined;
  const skipped: WizardStep[] = step === "complete" && unassignedMeetings.length === 0 ? ["resolve"] : [];

  return (
    <div className={REDISTRIBUTE_ROOT}>
      <PageBand
        back={{ href: TEAM_HREF, label: "Team" }}
        title={
          <>
            Redistribute <span translate="no">{possessive(name)}</span> calls
          </>
        }
        description={<BandLine unavailability={unavailability} />}
      >
        <StepTabs step={step} skipped={skipped} />
      </PageBand>

      {step === "review" && (
        <ReviewStep
          calls={sortedMeetings}
          pendingCount={pendingMeetings.length}
          selectedIds={selectedMeetingIds}
          onToggle={toggleMeeting}
          onToggleAll={toggleAllMeetings}
          onNext={() => setStep("distribute")}
          onBackToTeam={backToTeam}
          day={formatDay(unavailability.date)}
          partial={!unavailability.isFullDay}
        />
      )}
      {step === "distribute" && (
        <DistributeStep
          closers={availableClosers}
          selectedIds={selectedCloserIds}
          callCount={selectedMeetingIds.size}
          onToggle={toggleCloser}
          onToggleAll={toggleAllClosers}
          onBack={() => setStep("review")}
          onMove={() => setMoveOpen(true)}
          isDistributing={isDistributing}
        />
      )}
      {step === "resolve" && (
        <ResolveStep
          call={currentUnassigned}
          reason={resolveReason}
          closerName={name}
          index={currentResolveIndex}
          total={unassignedMeetings.length}
          closers={enabledClosers}
          closerId={resolveCloserId}
          onCloserChange={setResolveCloserId}
          onAssign={handleForceAssign}
          onCancelCall={() => setCancelOpen(true)}
          resolving={resolving}
        />
      )}
      {step === "complete" && <DoneStep movedTo={movedTo} canceledCount={canceledCount} onBackToTeam={backToTeam} />}

      <MoveCallsDialog
        open={moveOpen && step === "distribute"}
        onOpenChange={setMoveOpen}
        onConfirm={handleAutoDistribute}
        closerName={name}
        day={dayAndHours(unavailability)}
        calls={selectedCalls}
        pendingCount={pendingMeetings.length}
        toNames={chosenNames}
      />
      {currentUnassigned ? (
        <CancelCallDialog
          open={cancelOpen && step === "resolve"}
          onOpenChange={setCancelOpen}
          onConfirm={handleCancelMeeting}
          call={currentUnassigned}
          closerName={name}
          day={formatDay(unavailability.date)}
        />
      ) : null}
    </div>
  );
}

/**
 * The band's one line: "Off sick all day Thursday, Nov 5 · Flu, back Monday".
 * The day explains its time zone on hover; a long note waits behind "Note".
 */
function BandLine({ unavailability }: { unavailability: Unavailability }) {
  const off = offPhrase(unavailability.reason);
  const { isFullDay, startTime, endTime } = unavailability;
  const hours = !isFullDay && startTime !== undefined && endTime !== undefined ? formatHours(startTime, endTime) : null;
  const note = unavailability.note?.trim();
  return (
    <>
      {off.charAt(0).toUpperCase() + off.slice(1)} {hours ? `${hours} on ` : "all day "}
      <HelpTip tip="Days and times follow your browser's time zone.">{formatDay(unavailability.date)}</HelpTip>
      {note ? (
        note.length <= NOTE_IN_LINE ? (
          <> · {note}</>
        ) : (
          <>
            {" · "}
            <HelpTip tip={note}>Note</HelpTip>
          </>
        )
      ) : null}
    </>
  );
}
