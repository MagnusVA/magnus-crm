"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import posthog from "posthog-js";
import {
	AtSignIcon,
	CheckIcon,
	CopyIcon,
	NotebookPenIcon,
	RefreshCwIcon,
	XIcon,
} from "lucide-react";
import type { PortalCopyResult, PortalLeadRow } from "../actions";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { isPostHogEnabled } from "@/lib/posthog-config";
import { reportClientError } from "@/lib/observability/report-client-error";
import { SCHEDULING_MODE_LABEL } from "@/lib/scheduling-mode";
import { cn } from "@/lib/utils";
import {
	buildLinkSheet,
	buildTileUrl,
	defaultCampaign,
	firstName,
	type LinkSheetProgram,
	type LinkTile,
} from "./link-sheet-model";
import { PortalHeader, SignOutButton } from "./portal-header";
import { PortalLeadsPanel } from "./portal-leads-panel";
import type {
	PortalActions,
	PortalBootstrap,
	PortalCampaign,
	PortalCloser,
} from "./portal-types";
import { PortalColumn } from "./portal-ui";

/** How long a tile reads "Copied" after a tap. */
const FLASH_MS = 1600;

type CopyStatus = "logging" | "logged" | "rate_limited" | "failed" | "manual";

type Copied = {
	tileKey: string;
	programName: string;
	mode: LinkTile["mode"];
	url: string;
	campaign: PortalCampaign;
	status: CopyStatus;
};

type NoteState = "idle" | "saving" | "saved" | { error: string };

type SessionEnd = null | "expired" | "logged_out";

export function leadHandle(row: Pick<PortalLeadRow, "socialHandles" | "displayName">) {
	const handle = row.socialHandles[0]?.handle;
	return handle ? `@${handle.replace(/^@/, "")}` : row.displayName;
}

/**
 * Concept C's one sheet of links: "Hi <name>", campaign chips, then every
 * program the closer's team can book with Priority and Standard side by
 * side. Tap to copy; each copy goes through the logged copy action, which
 * re-checks on the server that the team can use the event type.
 */
export function PortalLinkSheet({
	portalSlug,
	bootstrap,
	closer,
	sessionExpiresAt,
	actions,
	onNotYou,
}: {
	portalSlug: string;
	bootstrap: PortalBootstrap;
	closer: PortalCloser;
	sessionExpiresAt: number | null;
	actions: PortalActions;
	onNotYou: () => void;
}) {
	const programs = useMemo(
		() => buildLinkSheet(bootstrap.bookablePrograms, closer),
		[bootstrap.bookablePrograms, closer],
	);
	const [campaignId, setCampaignId] = useState<string | null>(null);
	const campaign =
		bootstrap.campaignPresets.find((preset) => preset.id === campaignId) ??
		defaultCampaign(bootstrap.campaignPresets);
	const [flash, setFlash] = useState<string | null>(null);
	const [copied, setCopied] = useState<Copied | null>(null);
	const [sessionEnd, setSessionEnd] = useState<SessionEnd>(null);
	const [lead, setLead] = useState<PortalLeadRow | null>(null);
	const [leadsOpen, setLeadsOpen] = useState(false);
	const [note, setNote] = useState<NoteState>("idle");
	const flashTimer = useRef<number | null>(null);
	const copyRun = useRef(0);

	// The session cookie ends at a fixed time; stop offering links then, so
	// nothing gets copied that the server would refuse to log.
	useEffect(() => {
		if (!sessionExpiresAt) return;
		// Already past: fires on the next tick. setTimeout can't wait longer
		// than ~24.8 days; sessions are at most 24 hours.
		const remaining = Math.max(0, sessionExpiresAt - Date.now());
		const timer = window.setTimeout(() => setSessionEnd("expired"), remaining);
		return () => window.clearTimeout(timer);
	}, [sessionExpiresAt]);

	useEffect(
		() => () => {
			if (flashTimer.current) window.clearTimeout(flashTimer.current);
		},
		[],
	);

	async function copyTile(program: LinkSheetProgram, tile: LinkTile) {
		if (!campaign || sessionEnd) return;
		let url: string;
		try {
			url = buildTileUrl(tile, closer, campaign);
		} catch {
			return; // buildLinkSheet already hides URLs that don't parse.
		}
		const run = ++copyRun.current;
		const base: Omit<Copied, "status"> = {
			tileKey: tile.key,
			programName: program.programName,
			mode: tile.mode,
			url,
			campaign,
		};
		setNote("idle");

		try {
			await navigator.clipboard.writeText(url);
		} catch {
			// No clipboard access (old browser, iframe): show the link to copy by hand.
			setCopied({ ...base, status: "manual" });
			return;
		}

		setFlash(tile.key);
		if (flashTimer.current) window.clearTimeout(flashTimer.current);
		flashTimer.current = window.setTimeout(() => setFlash(null), FLASH_MS);
		setCopied({ ...base, status: "logging" });

		let result: PortalCopyResult = { recorded: false, reason: "failed" };
		try {
			result = await actions.recordPortalCopy(portalSlug, {
				eventTypeConfigId: tile.eventTypeConfigId,
				dmCloserId: closer.id,
				campaignPresetId: campaign.id,
			});
		} catch (error) {
			reportClientError(error, { flow: "link_portal_copy_audit" });
		}
		if (!result.recorded && result.reason === "logged_out") {
			setSessionEnd("logged_out");
		}
		if (run === copyRun.current) {
			const status: CopyStatus = result.recorded
				? "logged"
				: result.reason === "rate_limited"
					? "rate_limited"
					: "failed";
			setCopied({ ...base, status });
		}

		if (isPostHogEnabled()) {
			posthog.capture("dm_link_copied", {
				event_type_config_id: tile.eventTypeConfigId,
				booking_program_id: program.programId,
				dm_closer_id: closer.id,
				team_id: closer.teamId,
				campaign_preset_id: campaign.id,
				campaign: campaign.utmCampaign,
				scheduling_mode: tile.mode,
				lead_pinned: lead !== null,
				copy_audit_attempted: true,
				copy_audit_recorded: result.recorded,
			});
		}
	}

	async function noteOnLead() {
		if (!lead || !copied) return;
		setNote("saving");
		try {
			const result = await actions.addPortalLeadNote(portalSlug, {
				dmCloserId: closer.id,
				leadId: lead.leadId,
				content: `Sent the ${copied.programName} · ${SCHEDULING_MODE_LABEL[copied.mode]} booking link (${copied.campaign.label}).`,
			});
			if (result.status === "ok") setNote("saved");
			else if (result.status === "logged_out") {
				setSessionEnd("logged_out");
				setNote("idle");
			} else setNote({ error: result.message });
		} catch (error) {
			reportClientError(error, { flow: "link_portal_copy_note" });
			setNote({ error: "Could not add the note. Try again in a moment." });
		}
	}

	const signOut = actions.logoutPortal.bind(null, portalSlug);
	const noCampaigns = bootstrap.campaignPresets.length === 0;

	return (
		<main className="flex min-h-dvh flex-col bg-background">
			<PortalHeader
				tenantName={bootstrap.tenantName}
				sticky
				action={<SignOutButton action={signOut} />}
			>
				<div className="mt-1.5 flex items-end justify-between gap-2">
					<div className="min-w-0">
						<h1 className="truncate text-[19px] leading-[1.1] font-semibold">
							Hi {firstName(closer.displayName)}
						</h1>
						<p className="mt-0.5 truncate text-[12px] text-board-muted">
							{closer.teamDisplayName} · links credit you
						</p>
					</div>
					<button
						type="button"
						onClick={onNotYou}
						className="text-[12px] whitespace-nowrap text-board-muted underline underline-offset-2 outline-none hover:text-board-foreground focus-visible:ring-2 focus-visible:ring-primary/50"
					>
						Not you?
					</button>
				</div>
				<div
					role="group"
					aria-label="Campaign"
					className="mt-2.5 flex flex-wrap items-center gap-[5px]"
				>
					<span className="mr-0.5 font-condensed text-[11px] leading-none font-semibold tracking-[0.12em] text-board-muted uppercase">
						Campaign
					</span>
					{noCampaigns ? (
						<span className="text-[12px] text-board-danger">
							No campaigns yet. Ask your admin to add one.
						</span>
					) : (
						bootstrap.campaignPresets.map((preset) => {
							const on = campaign?.id === preset.id;
							return (
								<button
									key={preset.id}
									type="button"
									aria-pressed={on}
									onClick={() => {
										setCampaignId(preset.id);
										setCopied(null);
									}}
									className={cn(
										"h-[30px] flex-none rounded-[6px] border border-board-foreground/15 bg-board-raised px-[10px] font-condensed text-[13px] leading-none font-semibold tracking-[0.04em] whitespace-nowrap text-board-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/60 sm:h-[26px] sm:px-[9px] sm:text-[12.5px]",
										on && "border-board-foreground bg-board-foreground text-board",
									)}
								>
									{preset.label}
								</button>
							);
						})
					)}
				</div>
			</PortalHeader>

			<PortalColumn
				className={cn(
					"flex flex-1 flex-col pb-[calc(env(safe-area-inset-bottom)+16px)]",
					// Room for the copied sheet, so the last links stay reachable.
					copied && "pb-[calc(env(safe-area-inset-bottom)+220px)]",
				)}
			>
				<LeadBar
					lead={lead}
					onFind={() => setLeadsOpen(true)}
					onClear={() => setLead(null)}
				/>

				{sessionEnd ? (
					<div
						role="alert"
						className="flex items-start gap-2.5 border-b border-border bg-warning-surface px-3.5 py-3 text-[13px] text-warning-ink"
					>
						<div className="min-w-0 flex-1">
							<b className="font-semibold">You were signed out.</b>{" "}
							{sessionEnd === "expired"
								? "Your session ended. Enter the password again to keep copying links."
								: "The last link was copied but not logged. Enter the password again."}
						</div>
						<button
							type="button"
							onClick={() => window.location.reload()}
							className="inline-flex h-7 flex-none items-center gap-1.5 rounded-[5.6px] border border-warning-ink/30 bg-card px-2 text-[12.5px] font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							<RefreshCwIcon aria-hidden className="size-3.5" />
							Sign in
						</button>
					</div>
				) : null}

				{programs.length === 0 ? (
					<p className="px-[18px] py-7 text-center text-[13px] text-muted-foreground">
						No links yet for {closer.teamDisplayName}.
						<br />
						Ask your admin to set up its booking links.
					</p>
				) : (
					<ul aria-label="Booking links">
						{programs.map((program) => (
							<li
								key={program.programId}
								className="border-b border-border bg-card px-3 pt-[9px] pb-2.5"
							>
								<h2 className="mb-1.5 text-[14px] leading-tight font-semibold sm:text-[13.5px]">
									{program.programName}
								</h2>
								<div
									className={cn(
										"grid items-start gap-1.5",
										modeColumns(program.tiles).length === 1 ? "grid-cols-1" : "grid-cols-2",
									)}
								>
									{modeColumns(program.tiles).map((column) => (
										<div key={column[0]?.mode} className="flex min-w-0 flex-col gap-1.5">
											{column.map((tile) => (
												<LinkTileButton
													key={tile.key}
													program={program}
													tile={tile}
													copied={flash === tile.key}
													disabled={!campaign || sessionEnd !== null}
													onCopy={() => void copyTile(program, tile)}
												/>
											))}
										</div>
									))}
								</div>
							</li>
						))}
					</ul>
				)}

				<p className="px-3.5 pt-2.5 pb-4 text-center text-[12px] text-muted-foreground">
					Tap a link to copy it. Each link carries your name, so the booking
					credits you.
					{sessionExpiresAt && !sessionEnd ? (
						<>
							<br />
							Signed in until <SessionEnd at={sessionExpiresAt} />.
						</>
					) : null}
				</p>
			</PortalColumn>

			{copied ? (
				<CopiedSheet
					copied={copied}
					closer={closer}
					lead={lead}
					note={note}
					onNote={() => void noteOnLead()}
					onDone={() => setCopied(null)}
				/>
			) : null}

			<Sheet open={leadsOpen} onOpenChange={setLeadsOpen}>
				<SheetContent
					side="bottom"
					className="mx-auto max-h-[88dvh] w-full max-w-[440px] gap-0 overflow-y-auto rounded-t-[14px] p-0"
				>
					<SheetHeader className="border-b border-border px-4 pt-4 pb-3">
						<SheetTitle>Your prospects</SheetTitle>
						<SheetDescription className="sr-only">
							Search leads to pin one above your links, update their details, or add notes.
						</SheetDescription>
					</SheetHeader>
					<div className="px-4 pt-3 pb-6">
						<PortalLeadsPanel
							portalSlug={portalSlug}
							closerId={closer.id}
							closerName={closer.displayName}
							initialSearch={lead ? leadHandle(lead).replace(/^@/, "") : ""}
							pinnedLeadId={lead?.leadId ?? null}
							onPin={(row) => {
								setLead(row);
								if (row) setLeadsOpen(false);
							}}
							searchPortalLeads={actions.searchPortalLeads}
							updatePortalLeadProfile={actions.updatePortalLeadProfile}
							addPortalLeadNote={actions.addPortalLeadNote}
							listPortalLeadNotes={actions.listPortalLeadNotes}
						/>
					</div>
				</SheetContent>
			</Sheet>
		</main>
	);
}

/** Priority tiles in one column and Standard in the other, side by side. */
function modeColumns(tiles: LinkTile[]) {
	return (["normal", "extended"] as const)
		.map((mode) => tiles.filter((tile) => tile.mode === mode))
		.filter((column) => column.length > 0);
}

function SessionEnd({ at }: { at: number }) {
	return (
		<time dateTime={new Date(at).toISOString()} suppressHydrationWarning>
			{new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(at)}
		</time>
	);
}

function LeadBar({
	lead,
	onFind,
	onClear,
}: {
	lead: PortalLeadRow | null;
	onFind: () => void;
	onClear: () => void;
}) {
	if (!lead) {
		return (
			<button
				type="button"
				onClick={onFind}
				className="flex min-h-11 w-full items-center gap-2.5 border-b border-border bg-background px-3.5 py-2 text-left text-[13px] text-muted-foreground outline-none hover:bg-card focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
			>
				<AtSignIcon aria-hidden className="size-4 flex-none" />
				<span className="min-w-0 flex-1">For a prospect? Find them to keep notes.</span>
				<span className="font-medium whitespace-nowrap text-primary-ink">Find</span>
			</button>
		);
	}
	return (
		<div className="flex min-h-11 items-center gap-2 border-b border-border bg-card px-3.5 py-2 text-[13px]">
			<span className="font-condensed text-[11px] leading-none font-semibold tracking-[0.14em] text-muted-foreground uppercase">
				For
			</span>
			<button
				type="button"
				onClick={onFind}
				className="min-w-0 flex-1 truncate text-left outline-none focus-visible:underline"
				title="Details and notes"
			>
				<b className="font-semibold">{leadHandle(lead)}</b>
				{lead.socialHandles.length > 0 ? (
					<span className="text-muted-foreground"> · {lead.displayName}</span>
				) : null}
			</button>
			<button
				type="button"
				onClick={onFind}
				className="inline-flex h-7 flex-none items-center gap-1.5 rounded-[5.6px] border border-input bg-background px-2 text-[12.5px] font-medium outline-none hover:bg-card focus-visible:ring-2 focus-visible:ring-ring"
			>
				<NotebookPenIcon aria-hidden className="size-3.5" />
				Notes
			</button>
			<button
				type="button"
				onClick={onClear}
				aria-label={`Unpin ${leadHandle(lead)}`}
				className="grid size-7 flex-none place-items-center rounded-[5.6px] text-muted-foreground outline-none hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
			>
				<XIcon aria-hidden className="size-4" />
			</button>
		</div>
	);
}

function LinkTileButton({
	program,
	tile,
	copied,
	disabled,
	onCopy,
}: {
	program: LinkSheetProgram;
	tile: LinkTile;
	copied: boolean;
	disabled: boolean;
	onCopy: () => void;
}) {
	const mode = SCHEDULING_MODE_LABEL[tile.mode];
	return (
		<button
			type="button"
			onClick={onCopy}
			disabled={disabled}
			aria-label={`Copy ${program.programName} ${mode} link${tile.eventTypeHint ? ` (${tile.eventTypeHint})` : ""}`}
			className={cn(
				"flex min-h-[48px] min-w-0 items-center justify-between gap-1.5 rounded-[7px] border border-input bg-card py-1.5 pr-2 pl-[9px] text-left transition-colors duration-150 outline-none hover:border-foreground focus-visible:border-foreground focus-visible:ring-2 focus-visible:ring-ring/40 active:scale-[0.99] disabled:cursor-default disabled:opacity-55 disabled:hover:border-input sm:min-h-[42px]",
				copied && "border-primary bg-primary text-board hover:border-primary",
			)}
		>
			<span className="flex min-w-0 flex-col">
				<span className="font-condensed text-[12.5px] leading-none font-bold tracking-[0.08em] uppercase">
					{copied ? "Copied" : mode}
				</span>
				<span
					className={cn(
						"mt-[3px] truncate text-[12px] whitespace-nowrap",
						copied ? "text-board" : "text-muted-foreground",
					)}
				>
					{copied ? mode : (tile.eventTypeHint ?? "Tap to copy")}
				</span>
			</span>
			{copied ? (
				<CheckIcon aria-hidden className="size-[15px] flex-none" />
			) : (
				<CopyIcon aria-hidden className="size-[15px] flex-none" />
			)}
		</button>
	);
}

const PARAM_TONE: Record<string, string> = {
	utm_source: "text-stage-booked-ink",
	utm_medium: "text-stage-follow-up-ink",
	utm_campaign: "text-warning-ink",
};

function ColoredUrl({ url }: { url: string }) {
	const [base, query = ""] = url.split("?");
	const params = query ? query.split("&") : [];
	return (
		<>
			{(base ?? "").replace(/^https?:\/\//, "")}
			{params.length ? "?" : ""}
			{params.map((param, index) => {
				const tone = PARAM_TONE[param.split("=")[0] ?? ""];
				return (
					<span key={`${param}-${index}`}>
						{index > 0 ? "&" : ""}
						<span className={cn(tone && `font-semibold ${tone}`)}>{param}</span>
					</span>
				);
			})}
		</>
	);
}

function CopiedSheet({
	copied,
	closer,
	lead,
	note,
	onNote,
	onDone,
}: {
	copied: Copied;
	closer: PortalCloser;
	lead: PortalLeadRow | null;
	note: NoteState;
	onNote: () => void;
	onDone: () => void;
}) {
	const urlRef = useRef<HTMLDivElement>(null);
	const manual = copied.status === "manual";
	const mode = SCHEDULING_MODE_LABEL[copied.mode];

	// Without clipboard access, select the link so a long-press copies it.
	useEffect(() => {
		if (!manual || !urlRef.current) return;
		const range = document.createRange();
		range.selectNodeContents(urlRef.current);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
	}, [manual, copied.url]);

	const status =
		copied.status === "logging" ? (
			<span className="inline-flex items-center gap-1.5">
				<Spinner className="size-3" /> Logging the copy…
			</span>
		) : copied.status === "logged" ? (
			"Logged in your admin’s recent link copies."
		) : copied.status === "rate_limited" ? (
			<span className="text-danger-ink">
				Copied, but not logged: too many links in the last minute. Wait a minute
				before the next one.
			</span>
		) : copied.status === "failed" ? (
			<span className="text-danger-ink">Copied, but not logged. The link still works.</span>
		) : (
			"Your browser blocked copying. Press and hold the link to copy it."
		);

	return (
		<div
			role="status"
			aria-live="polite"
			className="fixed inset-x-0 bottom-0 z-30 animate-in duration-300 ease-out slide-in-from-bottom-6 fade-in-0 motion-reduce:animate-none"
		>
			<PortalColumn className="border-t border-border bg-card px-3.5 pt-3 pb-[calc(env(safe-area-inset-bottom)+16px)] shadow-[0_-10px_24px_rgba(20,26,40,.12)] sm:rounded-t-[12px] sm:border-x">
				<div className="flex items-center gap-1.5 text-[13.5px] font-semibold">
					{manual ? (
						<CopyIcon aria-hidden className="size-[15px] flex-none" />
					) : (
						<CheckIcon aria-hidden className="size-[15px] flex-none" />
					)}
					<span className="min-w-0 truncate">
						{manual ? "Copy this link" : "Copied"} · {copied.programName} · {mode}
					</span>
				</div>
				<div
					ref={urlRef}
					translate="no"
					className="my-2 rounded-[7px] border border-border bg-background p-2 font-mono text-[12px] leading-[1.45] break-all select-all"
				>
					<ColoredUrl url={copied.url} />
				</div>
				<p className="mb-2 text-[12px] text-muted-foreground">
					{status}
					{/\s/.test(closer.utmMedium) ? (
						<b className="ml-1 text-warning-ink">Your utm_medium has a space; tell your admin.</b>
					) : null}
				</p>
				<div className="flex flex-wrap items-center gap-2">
					<button
						type="button"
						autoFocus
						onClick={onDone}
						className="h-8 rounded-[5.6px] border border-input bg-background px-3 text-[13px] font-medium outline-none hover:bg-card focus-visible:ring-2 focus-visible:ring-ring sm:h-[26px] sm:px-2 sm:text-[12.5px]"
					>
						Done
					</button>
					{lead && !manual ? (
						note === "saved" ? (
							<span className="text-[12px] text-muted-foreground">
								Noted on {leadHandle(lead)}.
							</span>
						) : (
							<button
								type="button"
								onClick={onNote}
								disabled={note === "saving"}
								className="inline-flex h-8 items-center gap-1.5 rounded-[5.6px] border border-input bg-background px-3 text-[13px] font-medium outline-none hover:bg-card focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 sm:h-[26px] sm:px-2 sm:text-[12.5px]"
							>
								{note === "saving" ? (
									<Spinner className="size-3" />
								) : (
									<NotebookPenIcon aria-hidden className="size-3.5" />
								)}
								Note it on {leadHandle(lead)}
							</button>
						)
					) : null}
					{typeof note === "object" ? (
						<span className="text-[12px] text-danger-ink">{note.error}</span>
					) : null}
				</div>
			</PortalColumn>
		</div>
	);
}
