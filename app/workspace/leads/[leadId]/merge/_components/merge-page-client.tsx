"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { PageBand } from "@/app/workspace/_components/page-band";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { detailLinkClass } from "@/app/workspace/closer/meetings/_components/detail-card";
import { useKeptWhileLoading } from "@/app/workspace/operations/lead-gen/_components/use-kept-while-loading";
import { CARD } from "@/app/workspace/team/_components/team-ui";
import { usePageTitle } from "@/hooks/use-page-title";
import { getErrorMessage } from "@/lib/errors";
import { personLabel, shortLabel } from "./merge-format";
import { MergePreviewCard } from "./merge-preview";
import { MergeSearchCard, type PickerPerson } from "./merge-search";
import { MERGE_ROOT, MergePageSkeleton, PreviewCardSkeleton } from "./merge-skeleton";

const MergeConfirmDialog = dynamic(() => import("./merge-confirm-dialog").then((mod) => mod.MergeConfirmDialog));

/**
 * Merge people: find the person to keep, compare the two, then confirm.
 * The person on this page (the source) is absorbed into the one chosen.
 */
export function MergePageClient({ sourceLeadId }: { sourceLeadId: Id<"leads"> }) {
  const router = useRouter();
  usePageTitle("Merge people");

  const [searchTerm, setSearchTerm] = useState("");
  const [target, setTarget] = useState<PickerPerson | null>(null);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [isMerging, setIsMerging] = useState(false);

  // Both queries pause while the merge runs: once it lands the source reads
  // as merged and the preview refuses it, so the page holds what it last
  // showed until it navigates to the person kept, and keeps it on screen
  // (with the dialog open) while the queries resume after a failure.
  const sourceQuery = useQuery(api.leads.queries.getLeadDetail, isMerging ? "skip" : { leadId: sourceLeadId });
  const previewQuery = useQuery(
    api.leads.queries.getMergePreview,
    target && !isMerging ? { sourceLeadId, targetLeadId: target._id } : "skip",
  );
  const keptSource = useKeptWhileLoading(sourceQuery, sourceLeadId);
  const sourceDetail = keptSource.phrase === sourceLeadId ? keptSource.data : undefined;
  const previewKey = target ? `${sourceLeadId}:${target._id}` : "";
  const keptPreview = useKeptWhileLoading(previewQuery, previewKey);
  // Another person's preview never stands in for the one just chosen.
  const mergePreview = target && keptPreview.phrase === previewKey ? keptPreview.data : undefined;

  const mergeLead = useMutation(api.leads.merge.mergeLead);

  // A source already merged opens its merge from the person it went into.
  const redirectToLeadId = sourceDetail?.redirectToLeadId ?? null;
  useEffect(() => {
    if (redirectToLeadId && !isMerging) {
      router.replace(`/workspace/leads/${redirectToLeadId}/merge`);
    }
  }, [redirectToLeadId, isMerging, router]);

  function handleSelectTarget(person: PickerPerson) {
    setTarget(person);
  }

  function handleChangePerson() {
    setTarget(null);
    setIsConfirmOpen(false);
  }

  async function handleConfirmMerge() {
    if (!target) return;
    setIsMerging(true);
    try {
      await mergeLead({ sourceLeadId, targetLeadId: target._id });
      toast.success("Leads merged successfully");
      router.replace(`/workspace/leads/${target._id}`);
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to merge leads"));
      setIsMerging(false);
    }
  }

  if (sourceDetail === undefined || redirectToLeadId) {
    return <MergePageSkeleton />;
  }

  const sourceLead = sourceDetail.lead;
  if (!sourceLead) {
    return (
      <div className={MERGE_ROOT}>
        <PageBand
          title="Person not found"
          description="The link may be old, or the person was removed."
          back={{ href: "/workspace/leads", label: "Leads & Customers" }}
        />
        <div className={CARD}>
          <SectionEmpty title="Nothing to merge here.">
            <Link href="/workspace/leads" className={detailLinkClass}>
              Find the person in Leads &amp; Customers
            </Link>
          </SectionEmpty>
        </div>
      </div>
    );
  }

  const sourceName = personLabel(sourceLead);
  const targetName = target ? personLabel(mergePreview?.target.lead ?? target) : null;

  return (
    <div className={MERGE_ROOT}>
      <PageBand
        title={
          targetName ? (
            <>
              Merge <span translate="no">{sourceName}</span> into <span translate="no">{targetName}</span>
            </>
          ) : (
            <>
              Merge <span translate="no">{sourceName}</span>
            </>
          )
        }
        description={
          target
            ? "Check which details survive and what moves, then merge."
            : `Find the person to keep. ${shortLabel(sourceLead)}'s deals, calls and programs move to them.`
        }
        back={{ href: `/workspace/leads/${sourceLeadId}`, label: "Person page" }}
      />

      {!target ? (
        <MergeSearchCard
          sourceLeadId={sourceLeadId}
          searchTerm={searchTerm}
          onSearchTermChange={setSearchTerm}
          onSelect={handleSelectTarget}
        />
      ) : mergePreview === undefined ? (
        <PreviewCardSkeleton />
      ) : (
        <>
          <MergePreviewCard data={mergePreview} onChangePerson={handleChangePerson} onReview={() => setIsConfirmOpen(true)} />
          <MergeConfirmDialog
            open={isConfirmOpen}
            onOpenChange={setIsConfirmOpen}
            data={mergePreview}
            merging={isMerging}
            onConfirm={handleConfirmMerge}
          />
        </>
      )}
    </div>
  );
}
