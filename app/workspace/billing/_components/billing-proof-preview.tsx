"use client";

import { useState } from "react";
import { ArrowUpRightIcon, FileIcon, ZoomInIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { DetailCard, detailLinkClass } from "@/app/workspace/closer/meetings/_components/detail-card";
import { cn } from "@/lib/utils";
import type { BillingPaymentDetail } from "./billing-payment-facts";
import { formatBytes, isImageContentType, isPdfContentType, proofTypeLabel } from "./billing-format";

type BillingProof = BillingPaymentDetail["proof"];

/** The proof file: its kind, size and link in the title row, a thumbnail at most 160px tall under it. */
export function BillingProofPreview({ proof, owed }: { proof: BillingProof; /** The payment still needs review, so a missing file is owed. */ owed: boolean }) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const proofSize = formatBytes(proof.size);
  const isImage = isImageContentType(proof.contentType);
  const isPdf = isPdfContentType(proof.contentType);

  if (!proof.url) {
    return (
      <DetailCard title="Proof" meta={<span className={cn("font-medium", owed && "text-warning-ink")}>Missing</span>}>
        <p className="px-4 py-2.5 text-[13px] text-muted-foreground">No proof file on record.</p>
      </DetailCard>
    );
  }

  return (
    <DetailCard
      title="Proof"
      meta={
        <>
          <span className="font-condensed text-[14px] font-semibold tracking-[0.02em] tabular-nums">
            {proofTypeLabel(proof.contentType)}
            {proofSize ? ` · ${proofSize}` : null}
          </span>
          <a href={proof.url} rel="noreferrer" target="_blank" className={cn(detailLinkClass, "gap-0.5 text-[13px]")}>
            Open proof
            <ArrowUpRightIcon aria-hidden="true" className="size-3.5" />
          </a>
        </>
      }
    >
      <div className="bg-background p-2.5">
        <div className="relative h-40 overflow-hidden rounded-[7px] border bg-card">
          {isImage ? (
            <button
              aria-label="View the proof image full size"
              className="group relative block size-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              onClick={() => setLightboxOpen(true)}
              type="button"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- a signed storage URL, not an optimizable asset */}
              <img alt="Payment proof" className="size-full object-contain p-1" src={proof.url} />
              <span className="absolute right-2 bottom-2 inline-flex h-7 items-center gap-1.5 rounded-[5.6px] bg-board px-2 text-[12px] font-medium text-board-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                <ZoomInIcon aria-hidden="true" className="size-3.5" />
                Full size
              </span>
            </button>
          ) : isPdf ? (
            <iframe className="size-full border-0 bg-card" src={proof.url} title="Payment proof PDF" />
          ) : (
            <div className="flex size-full flex-col items-center justify-center gap-1 p-4 text-center">
              <FileIcon aria-hidden="true" className="size-6 text-muted-foreground" />
              <p className="font-medium">{proof.contentType ?? "Attached file"}</p>
              <p className="text-[13px] text-muted-foreground">This file type can&apos;t preview here. Open it to check it.</p>
            </div>
          )}
        </div>
      </div>

      <Dialog onOpenChange={(open) => !open && setLightboxOpen(false)} open={lightboxOpen}>
        <DialogContent className="w-max max-w-[min(calc(100vw-2rem),1600px)] gap-0 p-2 sm:max-w-[min(calc(100vw-2rem),1600px)]">
          <DialogTitle className="sr-only">Payment proof image</DialogTitle>
          {/* eslint-disable-next-line @next/next/no-img-element -- a signed storage URL, not an optimizable asset */}
          <img
            alt="Payment proof, full size"
            className="block h-auto max-h-[min(90vh,1200px)] w-auto max-w-[min(calc(100vw-2rem),1600px)] object-contain"
            src={proof.url}
          />
          <div className="mt-2 flex justify-end">
            <Button asChild className="h-7" size="sm" variant="outline">
              <a href={proof.url} rel="noreferrer" target="_blank">
                Open original
                <ArrowUpRightIcon aria-hidden="true" data-icon="inline-end" />
              </a>
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </DetailCard>
  );
}
