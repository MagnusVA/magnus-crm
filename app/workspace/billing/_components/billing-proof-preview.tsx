"use client";

import { useState } from "react";
import type { FunctionReturnType } from "convex/server";
import {
	ArrowUpRightIcon,
	FileIcon,
	FileTextIcon,
	ZoomInIcon,
} from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	Empty,
	EmptyContent,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { cn } from "@/lib/utils";

type BillingPaymentDetail = NonNullable<
	FunctionReturnType<typeof api.billing.queries.getPaymentDetail>
>;
type BillingProof = BillingPaymentDetail["proof"];

function formatBytes(size: number | null) {
	if (size === null) return null;
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
	return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function isImageContentType(contentType: string | null) {
	return contentType?.startsWith("image/") ?? false;
}

function isPdfContentType(contentType: string | null) {
	return contentType === "application/pdf";
}

function proofTypeLabel(contentType: string | null) {
	if (!contentType) return "File";
	if (isImageContentType(contentType)) return "Image";
	if (isPdfContentType(contentType)) return "PDF";
	return contentType.split("/").pop() ?? "File";
}

export function BillingProofPreview({ proof }: { proof: BillingProof }) {
	const [lightboxOpen, setLightboxOpen] = useState(false);
	const proofSize = formatBytes(proof.size);
	const isImage = isImageContentType(proof.contentType);
	const isPdf = isPdfContentType(proof.contentType);
	const typeLabel = proofTypeLabel(proof.contentType);

	if (!proof.url) {
		return (
			<section aria-labelledby="billing-proof-heading" className="min-w-0">
				<header className="flex items-baseline justify-between gap-2 pb-1">
					<h2
						className="text-[0.625rem] font-semibold uppercase tracking-[0.22em] text-muted-foreground"
						id="billing-proof-heading"
					>
						Proof
					</h2>
				</header>
				<Empty className="mt-2 border-0 py-6">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<FileTextIcon aria-hidden="true" />
						</EmptyMedia>
						<EmptyTitle>No proof attached</EmptyTitle>
					</EmptyHeader>
					<EmptyContent>
						This payment has no proof file on record.
					</EmptyContent>
				</Empty>
			</section>
		);
	}

	return (
		<section aria-labelledby="billing-proof-heading" className="min-w-0">
			<header className="flex items-baseline justify-between gap-2 pb-1">
				<h2
					className="text-[0.625rem] font-semibold uppercase tracking-[0.22em] text-muted-foreground"
					id="billing-proof-heading"
				>
					Proof
				</h2>
				<span className="font-mono text-[0.68rem] tabular-nums text-muted-foreground/70">
					{typeLabel}
					{proofSize ? ` · ${proofSize}` : null}
				</span>
			</header>

			<div className="mt-1.5 flex min-h-0 flex-col gap-2">
				<div
					className={cn(
						"relative overflow-hidden rounded-sm border border-border/80 bg-muted/15",
						isPdf ? "h-[min(420px,52vh)]" : "aspect-3/4 max-h-[min(420px,52vh)]",
					)}
				>
					{isImage ? (
						<button
							aria-label="View proof image full size"
							className="group relative block size-full"
							onClick={() => setLightboxOpen(true)}
							type="button"
						>
							<img
								alt="Payment proof"
								className="size-full object-contain p-1"
								src={proof.url}
							/>
							<div className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover:bg-black/15">
								<ZoomInIcon className="size-5 text-white opacity-0 drop-shadow-sm transition-opacity group-hover:opacity-100" />
							</div>
						</button>
					) : isPdf ? (
						<iframe
							className="size-full border-0 bg-background"
							src={proof.url}
							title="Payment proof PDF"
						/>
					) : (
						<div className="flex size-full flex-col items-center justify-center gap-2 p-6 text-center">
							<div className="flex size-14 items-center justify-center rounded-sm border bg-muted/40">
								<FileIcon
									aria-hidden="true"
									className="size-7 text-muted-foreground"
								/>
							</div>
							<p className="text-xs font-medium text-foreground">
								{proof.contentType ?? "Attached file"}
							</p>
							{proofSize ? (
								<p className="text-[0.68rem] text-muted-foreground">
									{proofSize}
								</p>
							) : null}
						</div>
					)}
				</div>

				<Button asChild className="h-7 w-full text-xs" size="sm" variant="outline">
					<a href={proof.url} rel="noreferrer" target="_blank">
						Open proof
						<ArrowUpRightIcon
							aria-hidden="true"
							className="size-3"
							data-icon="inline-end"
						/>
					</a>
				</Button>
			</div>

			<Dialog
				onOpenChange={(open) => {
					if (!open) setLightboxOpen(false);
				}}
				open={lightboxOpen}
			>
				<DialogContent className="w-max max-w-[min(calc(100vw-2rem),1600px)] gap-0 border-0 bg-background/98 p-2 shadow-2xl sm:max-w-[min(calc(100vw-2rem),1600px)]">
					<DialogTitle className="sr-only">Payment proof image</DialogTitle>
					<img
						alt="Payment proof — full size"
						className="block h-auto max-h-[min(90vh,1200px)] w-auto max-w-[min(calc(100vw-2rem),1600px)] object-contain"
						src={proof.url}
					/>
					<div className="mt-2 flex justify-end">
						<Button asChild className="h-7 text-xs" size="sm" variant="outline">
							<a href={proof.url} rel="noreferrer" target="_blank">
								Open original
								<ArrowUpRightIcon
									aria-hidden="true"
									className="size-3"
									data-icon="inline-end"
								/>
							</a>
						</Button>
					</div>
				</DialogContent>
			</Dialog>
		</section>
	);
}
