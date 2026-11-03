"use client";

import { useId, useRef, useState } from "react";
import { AlertCircleIcon, FileCheckIcon, UploadIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PROOF_CONTENT_TYPES, PROOF_MAX_BYTES } from "@/lib/paymentProof";
import { cn } from "@/lib/utils";

/** Why a file can't be the proof, or null when it can. */
export function proofFileProblem(file: File): string | null {
	if (file.size > PROOF_MAX_BYTES) return "The file is over 10 MB. Pick a smaller one.";
	if (!(PROOF_CONTENT_TYPES as readonly string[]).includes(file.type)) {
		return "Pick a JPEG, PNG, GIF or PDF.";
	}
	return null;
}

/**
 * One large target for the receipt: tap to pick a photo or file, or drop
 * one on it. The chosen file shows its name with a remove button.
 */
export function ProofDropZone({
	file,
	onChange,
	disabled,
	error,
}: {
	file: File | undefined;
	onChange: (file: File | undefined) => void;
	disabled?: boolean;
	error?: string | null;
}) {
	const inputId = useId();
	const errorId = useId();
	const inputRef = useRef<HTMLInputElement>(null);
	const [dragging, setDragging] = useState(false);

	const clear = () => {
		onChange(undefined);
		if (inputRef.current) inputRef.current.value = "";
	};

	if (file) {
		// A file that can't be the proof keeps its name on screen, with the
		// reason under it, so the closer sees why Log payment did nothing.
		return (
			<div className="flex flex-col gap-1.5">
				<div
					className={cn(
						"flex min-w-0 items-center gap-3 rounded-xl border bg-muted/40 p-3",
						error && "border-destructive",
					)}
				>
					{error ? (
						<AlertCircleIcon aria-hidden="true" className="size-5 shrink-0 text-destructive" />
					) : (
						<FileCheckIcon aria-hidden="true" className="size-5 shrink-0 text-emerald-600" />
					)}
					<div className="flex min-w-0 flex-1 flex-col">
						<span className="truncate font-medium">{file.name}</span>
						<span className="text-sm text-muted-foreground tabular-nums">
							{(file.size / 1024).toFixed(1)} KB
						</span>
					</div>
					<Button
						type="button"
						variant="ghost"
						size="icon"
						disabled={disabled}
						onClick={clear}
						aria-label={`Remove ${file.name}`}
					>
						<XIcon />
					</Button>
				</div>
				{error ? (
					<p id={errorId} role="alert" className="text-sm text-destructive">
						{error}
					</p>
				) : null}
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-1.5">
			<label
				htmlFor={inputId}
				onDragOver={(event) => {
					event.preventDefault();
					setDragging(true);
				}}
				onDragLeave={() => setDragging(false)}
				onDrop={(event) => {
					event.preventDefault();
					setDragging(false);
					if (!disabled) onChange(event.dataTransfer.files?.[0]);
				}}
				className={cn(
					"flex min-h-36 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors",
					"focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50",
					dragging ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40",
					error && "border-destructive",
					disabled && "pointer-events-none opacity-60",
				)}
			>
				<UploadIcon aria-hidden="true" className="size-6 text-muted-foreground" />
				<span className="font-medium">Add the receipt</span>
				<span className="text-sm text-muted-foreground">
					A screenshot or PDF of the payment. JPEG, PNG, GIF or PDF, up to 10 MB.
				</span>
				<input
					ref={inputRef}
					id={inputId}
					type="file"
					accept={PROOF_CONTENT_TYPES.join(",")}
					disabled={disabled}
					aria-invalid={error ? true : undefined}
					aria-describedby={error ? errorId : undefined}
					className="sr-only"
					onChange={(event) => onChange(event.target.files?.[0])}
				/>
			</label>
			{error ? (
				<p id={errorId} className="text-sm text-destructive">
					{error}
				</p>
			) : null}
		</div>
	);
}
