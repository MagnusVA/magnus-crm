"use client";

import { CheckIcon, ChevronRightIcon, CopyIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PortalPhoneCloser } from "./portal-types";
import { CloserInitials, PORTAL_LABEL } from "./portal-ui";

export type LinkMode = "programs" | "closers";

/** "Program links" or "Closer links", on the dark header under the greeting. */
export function LinkModeSwitch({
	mode,
	onChange,
}: {
	mode: LinkMode;
	onChange: (mode: LinkMode) => void;
}) {
	return (
		<div
			role="group"
			aria-label="Kind of link"
			className="mt-2.5 flex gap-[3px] rounded-[8px] bg-board-foreground/10 p-[3px]"
		>
			{(
				[
					["programs", "Program links"],
					["closers", "Closer links"],
				] as const
			).map(([value, label]) => {
				const on = mode === value;
				return (
					<button
						key={value}
						type="button"
						aria-pressed={on}
						onClick={() => onChange(value)}
						className={cn(
							"h-[30px] flex-1 rounded-[6px] font-condensed text-[13px] leading-none font-semibold tracking-[0.04em] text-board-muted outline-none focus-visible:ring-2 focus-visible:ring-primary/60 sm:h-[26px] sm:text-[12.5px]",
							on && "bg-board-foreground text-board",
						)}
					>
						{label}
					</button>
				);
			})}
		</div>
	);
}

/**
 * Closer links: pick a phone closer, then tap a program to copy that
 * closer's personal link for it.
 */
export function CloserLinksPanel({
	phoneClosers,
	programs,
	selected,
	onSelect,
	flashKey,
	disabled,
	error,
	onCopy,
}: {
	phoneClosers: PortalPhoneCloser[];
	programs: Array<{ id: string; name: string }>;
	selected: PortalPhoneCloser | null;
	onSelect: (closer: PortalPhoneCloser | null) => void;
	flashKey: string | null;
	disabled: boolean;
	error: string | null;
	onCopy: (closer: PortalPhoneCloser, program: { id: string; name: string }) => void;
}) {
	if (!selected) {
		return (
			<section aria-label="Phone closers" className="flex flex-col gap-1.5 px-3 pt-3 pb-1">
				<h2 className={cn(PORTAL_LABEL, "px-0.5")}>Which closer?</h2>
				{phoneClosers.map((closer) => (
					<button
						key={closer.id}
						type="button"
						onClick={() => onSelect(closer)}
						className="flex min-h-[48px] items-center gap-2.5 rounded-[7px] border border-input bg-card px-2.5 py-2 text-left outline-none hover:border-foreground focus-visible:border-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
					>
						<CloserInitials name={closer.displayName} />
						<span className="min-w-0 flex-1 truncate text-[14px] font-semibold">
							{closer.displayName}
						</span>
						<ChevronRightIcon aria-hidden className="size-4 flex-none text-muted-foreground" />
					</button>
				))}
			</section>
		);
	}

	return (
		<section aria-label={`${selected.displayName}'s links`} className="flex flex-col gap-1.5 px-3 pt-3 pb-1">
			<div className="flex min-h-11 items-center gap-2.5 rounded-[7px] border border-border bg-card px-2.5 py-1.5">
				<CloserInitials name={selected.displayName} />
				<div className="min-w-0 flex-1">
					<p className="truncate text-[14px] font-semibold">{selected.displayName}</p>
					<p className="text-[12px] text-muted-foreground">Their own calendar</p>
				</div>
				<button
					type="button"
					onClick={() => onSelect(null)}
					className="text-[12.5px] font-medium whitespace-nowrap text-primary-ink underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					Change
				</button>
			</div>
			{error ? (
				<p role="alert" className="rounded-[7px] border border-danger-ink/30 bg-card px-2.5 py-2 text-[12.5px] text-danger-ink">
					{error}
				</p>
			) : null}
			<h2 className={cn(PORTAL_LABEL, "px-0.5 pt-1.5")}>Which program?</h2>
			{programs.map((program) => {
				const key = `${selected.id}:${program.id}`;
				const copied = flashKey === key;
				return (
					<button
						key={program.id}
						type="button"
						onClick={() => onCopy(selected, program)}
						disabled={disabled}
						aria-label={`Copy ${selected.displayName}'s ${program.name} link`}
						className={cn(
							"flex min-h-[48px] min-w-0 items-center justify-between gap-1.5 rounded-[7px] border border-input bg-card py-1.5 pr-2.5 pl-2.5 text-left transition-colors duration-150 outline-none hover:border-foreground focus-visible:border-foreground focus-visible:ring-2 focus-visible:ring-ring/40 active:scale-[0.99] disabled:cursor-default disabled:opacity-55 disabled:hover:border-input sm:min-h-[42px]",
							copied && "border-primary bg-primary text-board hover:border-primary",
						)}
					>
						<span className="flex min-w-0 flex-col">
							<span className="truncate text-[14px] leading-tight font-semibold sm:text-[13.5px]">
								{program.name}
							</span>
							<span className={cn("mt-[3px] text-[12px]", copied ? "text-board" : "text-muted-foreground")}>
								{copied ? "Copied" : "Tap to copy"}
							</span>
						</span>
						{copied ? (
							<CheckIcon aria-hidden className="size-[15px] flex-none" />
						) : (
							<CopyIcon aria-hidden className="size-[15px] flex-none" />
						)}
					</button>
				);
			})}
		</section>
	);
}

/**
 * Copies a link the server builds. The clipboard write starts inside the tap
 * (Safari only allows it there) and waits for the link; when the server
 * refuses, nothing is copied. Returns "manual" when the browser blocks the
 * clipboard, so the link can be shown to copy by hand.
 */
export async function copyServerLink(
	link: Promise<string | null>,
): Promise<"copied" | "manual" | "refused"> {
	if (typeof ClipboardItem !== "undefined" && typeof navigator.clipboard?.write === "function") {
		try {
			await navigator.clipboard.write([
				new ClipboardItem({
					"text/plain": link.then((url) => {
						if (url === null) throw new Error("refused");
						return new Blob([url], { type: "text/plain" });
					}),
				}),
			]);
			return "copied";
		} catch {
			// Refused, or a browser without promised clipboard items: try below.
		}
	}
	const url = await link;
	if (url === null) return "refused";
	try {
		await navigator.clipboard.writeText(url);
		return "copied";
	} catch {
		return "manual";
	}
}
