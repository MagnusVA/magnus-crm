"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
	ChevronDownIcon,
	MessageSquareTextIcon,
	SearchIcon,
	AlertCircleIcon,
	RefreshCwIcon,
} from "lucide-react";
import type {
	PortalLeadInitialSource,
	PortalLeadNote,
	PortalLeadNoteInput,
	PortalLeadNoteResult,
	PortalLeadNotesResult,
	PortalLeadProfileInput,
	PortalLeadProfileResult,
	PortalLeadRow,
	PortalLeadSearchResult,
} from "../actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const SEARCH_DEBOUNCE_MS = 300;
const MIN_SEARCH_LENGTH = 2;
const NOTE_MAX_LENGTH = 2000;
const NOTE_COUNT_CAP = 20;

const INITIAL_SOURCE_META: Record<
	PortalLeadInitialSource,
	{ label: string; className: string }
> = {
	cta: {
		label: "CTA",
		className: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
	},
	inbound: {
		label: "Inbound",
		className:
			"border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
	},
	wechat: {
		label: "WeChat",
		className:
			"border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
	},
};

const SOURCE_SELECT_OPTIONS: Array<{
	value: PortalLeadInitialSource;
	label: string;
}> = [
	{ value: "cta", label: "CTA" },
	{ value: "inbound", label: "Inbound" },
	{ value: "wechat", label: "WeChat" },
];

const incomeFormatter = new Intl.NumberFormat(undefined, {
	maximumFractionDigits: 0,
});

const noteDateFormatter = new Intl.DateTimeFormat(undefined, {
	month: "short",
	day: "numeric",
	year: "numeric",
});

function formatRelativeTime(timestamp: number) {
	const elapsedMs = Date.now() - timestamp;
	const minutes = Math.floor(elapsedMs / 60_000);
	if (minutes < 1) {
		return "just now";
	}
	if (minutes < 60) {
		return `${minutes}m ago`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return `${hours}h ago`;
	}
	const days = Math.floor(hours / 24);
	if (days < 7) {
		return `${days}d ago`;
	}
	return noteDateFormatter.format(new Date(timestamp));
}

function noteCountLabel(noteCount: number) {
	return noteCount > NOTE_COUNT_CAP ? `${NOTE_COUNT_CAP}+` : String(noteCount);
}

type PortalLeadsPanelProps = {
	portalSlug: string;
	closerId: string;
	closerName: string;
	searchPortalLeads: (
		portalSlug: string,
		searchTerm: string,
	) => Promise<PortalLeadSearchResult>;
	updatePortalLeadProfile: (
		portalSlug: string,
		input: PortalLeadProfileInput,
	) => Promise<PortalLeadProfileResult>;
	addPortalLeadNote: (
		portalSlug: string,
		input: PortalLeadNoteInput,
	) => Promise<PortalLeadNoteResult>;
	listPortalLeadNotes: (
		portalSlug: string,
		leadId: string,
	) => Promise<PortalLeadNotesResult>;
};

export function PortalLeadsPanel({
	portalSlug,
	closerId,
	closerName,
	searchPortalLeads,
	updatePortalLeadProfile,
	addPortalLeadNote,
	listPortalLeadNotes,
}: PortalLeadsPanelProps) {
	const [searchInput, setSearchInput] = useState("");
	const [debouncedTerm, setDebouncedTerm] = useState("");
	const [results, setResults] = useState<PortalLeadRow[] | null>(null);
	const [searching, setSearching] = useState(false);
	const [searchError, setSearchError] = useState<string | null>(null);
	const [sessionExpired, setSessionExpired] = useState(false);
	const [expandedLeadId, setExpandedLeadId] = useState<string | null>(null);
	const requestIdRef = useRef(0);

	useEffect(() => {
		const term = searchInput.trim();
		const timeoutId = window.setTimeout(() => {
			setDebouncedTerm(term);

			if (term.length < MIN_SEARCH_LENGTH) {
				requestIdRef.current += 1;
				setResults(null);
				setSearching(false);
				setSearchError(null);
				return;
			}

			const requestId = ++requestIdRef.current;
			setSearching(true);
			setSearchError(null);

			void searchPortalLeads(portalSlug, term).then((result) => {
				if (requestId !== requestIdRef.current) {
					return;
				}
				setSearching(false);
				if (result.status === "ok") {
					setResults(result.rows);
				} else if (result.status === "logged_out") {
					setSessionExpired(true);
				} else {
					setSearchError(result.message);
				}
			});
		}, SEARCH_DEBOUNCE_MS);
		return () => window.clearTimeout(timeoutId);
	}, [searchInput, portalSlug, searchPortalLeads]);

	function updateRow(updated: PortalLeadRow) {
		setResults((current) =>
			current
				? current.map((row) => (row.leadId === updated.leadId ? updated : row))
				: current,
		);
	}

	if (sessionExpired) {
		return (
			<Alert variant="destructive">
				<AlertCircleIcon aria-hidden="true" />
				<AlertTitle>Portal Session Expired</AlertTitle>
				<AlertDescription>
					<p>Reload the page and enter the portal password again.</p>
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="mt-2"
						onClick={() => window.location.reload()}
					>
						<RefreshCwIcon data-icon="inline-start" aria-hidden="true" />
						Reload
					</Button>
				</AlertDescription>
			</Alert>
		);
	}

	return (
		<Card className="rounded-lg">
			<CardHeader>
				<CardTitle>Lead Search</CardTitle>
				<CardDescription>
					Find a lead to set their initial source, self-reported income, and
					notes. Changes are saved as{" "}
					<span className="font-medium text-foreground">{closerName}</span>.
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<div className="flex flex-col gap-1.5">
					<div className="relative">
						<SearchIcon
							aria-hidden="true"
							className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
						/>
						<Input
							type="search"
							value={searchInput}
							onChange={(event) => setSearchInput(event.target.value)}
							placeholder="Search leads by name or handle…"
							aria-label="Search leads"
							className="pl-8"
						/>
					</div>
					<p className="text-xs text-muted-foreground">
						Type at least {MIN_SEARCH_LENGTH} characters to search.
					</p>
				</div>

				{searchError ? (
					<Alert variant="destructive">
						<AlertCircleIcon aria-hidden="true" />
						<AlertTitle>Search Failed</AlertTitle>
						<AlertDescription>{searchError}</AlertDescription>
					</Alert>
				) : null}

				{searching ? (
					<div className="flex min-h-24 items-center justify-center gap-2 rounded-lg border border-dashed bg-muted/20 p-3 text-sm text-muted-foreground">
						<Spinner />
						Searching leads…
					</div>
				) : results === null ? (
					<div className="flex min-h-24 items-center gap-3 rounded-lg border border-dashed bg-muted/20 p-3 text-sm text-muted-foreground">
						<SearchIcon className="size-5 shrink-0" aria-hidden="true" />
						<span>Search for a lead to update their details.</span>
					</div>
				) : results.length === 0 ? (
					<div className="flex min-h-24 items-center gap-3 rounded-lg border border-dashed bg-muted/20 p-3 text-sm text-muted-foreground">
						<SearchIcon className="size-5 shrink-0" aria-hidden="true" />
						<span>
							No leads matched &ldquo;{debouncedTerm}&rdquo;. Try another name
							or handle.
						</span>
					</div>
				) : (
					<ul className="flex flex-col gap-2">
						{results.map((row) => (
							<LeadResultCard
								key={row.leadId}
								row={row}
								expanded={expandedLeadId === row.leadId}
								onToggle={() =>
									setExpandedLeadId((current) =>
										current === row.leadId ? null : row.leadId,
									)
								}
								portalSlug={portalSlug}
								closerId={closerId}
								closerName={closerName}
								updatePortalLeadProfile={updatePortalLeadProfile}
								addPortalLeadNote={addPortalLeadNote}
								listPortalLeadNotes={listPortalLeadNotes}
								onRowUpdate={updateRow}
								onSessionExpired={() => setSessionExpired(true)}
							/>
						))}
					</ul>
				)}
			</CardContent>
		</Card>
	);
}

function LeadResultCard({
	row,
	expanded,
	onToggle,
	portalSlug,
	closerId,
	closerName,
	updatePortalLeadProfile,
	addPortalLeadNote,
	listPortalLeadNotes,
	onRowUpdate,
	onSessionExpired,
}: {
	row: PortalLeadRow;
	expanded: boolean;
	onToggle: () => void;
	portalSlug: string;
	closerId: string;
	closerName: string;
	updatePortalLeadProfile: PortalLeadsPanelProps["updatePortalLeadProfile"];
	addPortalLeadNote: PortalLeadsPanelProps["addPortalLeadNote"];
	listPortalLeadNotes: PortalLeadsPanelProps["listPortalLeadNotes"];
	onRowUpdate: (row: PortalLeadRow) => void;
	onSessionExpired: () => void;
}) {
	const detailId = `portal-lead-detail-${row.leadId}`;
	const sourceMeta = row.initialSource
		? INITIAL_SOURCE_META[row.initialSource]
		: null;

	return (
		<li className="rounded-lg border bg-background">
			<button
				type="button"
				onClick={onToggle}
				aria-expanded={expanded}
				aria-controls={detailId}
				className="flex w-full min-w-0 items-start gap-3 rounded-lg p-3 text-left transition-colors outline-none hover:bg-muted/60 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
			>
				<span className="flex min-w-0 flex-1 flex-col gap-1.5">
					<span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
						<span className="min-w-0 truncate font-medium">
							{row.displayName}
						</span>
						<Badge
							variant={row.status === "converted" ? "secondary" : "outline"}
						>
							{row.status === "converted" ? "Converted" : "Active"}
						</Badge>
					</span>
					{row.socialHandles.length > 0 ? (
						<span className="flex min-w-0 flex-wrap gap-1">
							{row.socialHandles.map((handle, index) => (
								<Badge
									key={`${handle.type}-${handle.handle}-${index}`}
									variant="secondary"
									className="max-w-full text-xs"
									translate="no"
								>
									<span className="truncate">
										{handle.type}: @{handle.handle}
									</span>
								</Badge>
							))}
						</span>
					) : null}
					<span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
						{sourceMeta ? (
							<Badge variant="outline" className={cn(sourceMeta.className)}>
								{sourceMeta.label}
							</Badge>
						) : (
							<span>No initial source</span>
						)}
						{row.selfReportedIncome !== null ? (
							<span className="tabular-nums">
								Income {incomeFormatter.format(row.selfReportedIncome)}
							</span>
						) : null}
						<span className="inline-flex items-center gap-1">
							<MessageSquareTextIcon className="size-3.5" aria-hidden="true" />
							{noteCountLabel(row.noteCount)}{" "}
							{row.noteCount === 1 ? "note" : "notes"}
						</span>
					</span>
				</span>
				<ChevronDownIcon
					aria-hidden="true"
					className={cn(
						"mt-1 size-4 shrink-0 text-muted-foreground transition-transform",
						expanded && "rotate-180",
					)}
				/>
			</button>
			{expanded ? (
				<div id={detailId} className="flex flex-col gap-4 border-t p-3">
					<LeadProfileEditor
						row={row}
						portalSlug={portalSlug}
						closerId={closerId}
						updatePortalLeadProfile={updatePortalLeadProfile}
						onRowUpdate={onRowUpdate}
						onSessionExpired={onSessionExpired}
					/>
					<LeadNotesSection
						row={row}
						portalSlug={portalSlug}
						closerId={closerId}
						closerName={closerName}
						addPortalLeadNote={addPortalLeadNote}
						listPortalLeadNotes={listPortalLeadNotes}
						onRowUpdate={onRowUpdate}
						onSessionExpired={onSessionExpired}
					/>
				</div>
			) : null}
		</li>
	);
}

function LeadProfileEditor({
	row,
	portalSlug,
	closerId,
	updatePortalLeadProfile,
	onRowUpdate,
	onSessionExpired,
}: {
	row: PortalLeadRow;
	portalSlug: string;
	closerId: string;
	updatePortalLeadProfile: PortalLeadsPanelProps["updatePortalLeadProfile"];
	onRowUpdate: (row: PortalLeadRow) => void;
	onSessionExpired: () => void;
}) {
	const [sourceValue, setSourceValue] = useState<
		PortalLeadInitialSource | "none"
	>(row.initialSource ?? "none");
	const [incomeValue, setIncomeValue] = useState(
		row.selfReportedIncome === null ? "" : String(row.selfReportedIncome),
	);
	const [saving, startSaving] = useTransition();
	const [saveMessage, setSaveMessage] = useState<{
		tone: "success" | "error";
		text: string;
	} | null>(null);

	const sourceFieldId = `portal-lead-source-${row.leadId}`;
	const incomeFieldId = `portal-lead-income-${row.leadId}`;

	function handleSave() {
		const trimmedIncome = incomeValue.trim();
		let income: number | null = null;
		if (trimmedIncome !== "") {
			const parsed = Number(trimmedIncome);
			if (!Number.isFinite(parsed) || parsed < 0) {
				setSaveMessage({
					tone: "error",
					text: "Enter a valid income amount (or leave it empty to clear).",
				});
				return;
			}
			income = parsed;
		}
		const source = sourceValue === "none" ? null : sourceValue;

		startSaving(async () => {
			const result = await updatePortalLeadProfile(portalSlug, {
				dmCloserId: closerId,
				leadId: row.leadId,
				initialSource: source,
				selfReportedIncome: income,
			});
			if (result.status === "ok") {
				onRowUpdate({
					...row,
					initialSource: source,
					selfReportedIncome: income,
				});
				setSaveMessage({ tone: "success", text: "Saved." });
			} else if (result.status === "logged_out") {
				onSessionExpired();
			} else {
				setSaveMessage({ tone: "error", text: result.message });
			}
		});
	}

	return (
		<div className="flex flex-col gap-3">
			<div className="grid gap-3 sm:grid-cols-2">
				<div className="flex flex-col gap-1.5">
					<Label htmlFor={sourceFieldId}>Initial Source</Label>
					<Select
						value={sourceValue}
						onValueChange={(value) => {
							setSourceValue(value as PortalLeadInitialSource | "none");
							setSaveMessage(null);
						}}
						disabled={saving}
					>
						<SelectTrigger id={sourceFieldId} className="w-full">
							<SelectValue placeholder="Not set" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="none">Not set</SelectItem>
							{SOURCE_SELECT_OPTIONS.map((option) => (
								<SelectItem key={option.value} value={option.value}>
									{option.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor={incomeFieldId}>Self-Reported Income</Label>
					<Input
						id={incomeFieldId}
						type="number"
						inputMode="decimal"
						min={0}
						step="any"
						value={incomeValue}
						onChange={(event) => {
							setIncomeValue(event.target.value);
							setSaveMessage(null);
						}}
						placeholder="e.g. 5000"
						disabled={saving}
					/>
				</div>
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<Button type="button" size="sm" onClick={handleSave} disabled={saving}>
					{saving ? (
						<>
							<Spinner data-icon="inline-start" />
							Saving…
						</>
					) : (
						"Save"
					)}
				</Button>
				<p
					aria-live="polite"
					className={cn(
						"text-xs",
						saveMessage?.tone === "error"
							? "text-destructive"
							: "text-muted-foreground",
					)}
				>
					{saveMessage?.text}
				</p>
			</div>
		</div>
	);
}

type NotesState =
	| { status: "loading" }
	| { status: "error"; message: string }
	| { status: "ok"; notes: PortalLeadNote[] };

function LeadNotesSection({
	row,
	portalSlug,
	closerId,
	closerName,
	addPortalLeadNote,
	listPortalLeadNotes,
	onRowUpdate,
	onSessionExpired,
}: {
	row: PortalLeadRow;
	portalSlug: string;
	closerId: string;
	closerName: string;
	addPortalLeadNote: PortalLeadsPanelProps["addPortalLeadNote"];
	listPortalLeadNotes: PortalLeadsPanelProps["listPortalLeadNotes"];
	onRowUpdate: (row: PortalLeadRow) => void;
	onSessionExpired: () => void;
}) {
	const [notesState, setNotesState] = useState<NotesState>({
		status: "loading",
	});
	const [noteContent, setNoteContent] = useState("");
	const [noteError, setNoteError] = useState<string | null>(null);
	const [noteAdded, setNoteAdded] = useState(false);
	const [addingNote, startAddingNote] = useTransition();

	const noteFieldId = `portal-lead-note-${row.leadId}`;

	useEffect(() => {
		let cancelled = false;
		void listPortalLeadNotes(portalSlug, row.leadId).then((result) => {
			if (cancelled) {
				return;
			}
			if (result.status === "ok") {
				setNotesState({ status: "ok", notes: result.notes });
			} else if (result.status === "logged_out") {
				onSessionExpired();
			} else {
				setNotesState({ status: "error", message: result.message });
			}
		});
		return () => {
			cancelled = true;
		};
		// Load once when the card expands; the lead id is stable for this card.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	function handleAddNote() {
		const content = noteContent.trim();
		if (content.length === 0) {
			setNoteError("Write a note first.");
			return;
		}
		if (content.length > NOTE_MAX_LENGTH) {
			setNoteError(`Notes are limited to ${NOTE_MAX_LENGTH} characters.`);
			return;
		}

		setNoteError(null);
		setNoteAdded(false);
		startAddingNote(async () => {
			const result = await addPortalLeadNote(portalSlug, {
				dmCloserId: closerId,
				leadId: row.leadId,
				content,
			});
			if (result.status === "ok") {
				const createdAt = Date.now();
				setNoteContent("");
				setNoteAdded(true);
				setNotesState((current) =>
					current.status === "ok"
						? {
								status: "ok",
								notes: [
									{
										noteId: result.noteId,
										content,
										createdAt,
										authorKind: "dm_closer",
										authorLabel: closerName,
									},
									...current.notes,
								],
							}
						: current,
				);
				onRowUpdate({
					...row,
					noteCount: row.noteCount + 1,
					lastNoteAt: createdAt,
				});
			} else if (result.status === "logged_out") {
				onSessionExpired();
			} else {
				setNoteError(result.message);
			}
		});
	}

	return (
		<div className="flex flex-col gap-3 border-t pt-3">
			<div className="flex flex-col gap-1.5">
				<Label htmlFor={noteFieldId}>Add a Note</Label>
				<Textarea
					id={noteFieldId}
					value={noteContent}
					onChange={(event) => {
						setNoteContent(event.target.value);
						setNoteError(null);
						setNoteAdded(false);
					}}
					placeholder="What did you learn about this lead?"
					maxLength={NOTE_MAX_LENGTH}
					disabled={addingNote}
					aria-invalid={noteError !== null}
				/>
				<div className="flex flex-wrap items-center gap-2">
					<Button
						type="button"
						size="sm"
						variant="outline"
						onClick={handleAddNote}
						disabled={addingNote || noteContent.trim().length === 0}
					>
						{addingNote ? (
							<>
								<Spinner data-icon="inline-start" />
								Adding…
							</>
						) : (
							"Add Note"
						)}
					</Button>
					<p
						aria-live="polite"
						className={cn(
							"text-xs",
							noteError ? "text-destructive" : "text-muted-foreground",
						)}
					>
						{noteError ?? (noteAdded ? "Note added." : null)}
					</p>
				</div>
			</div>

			{notesState.status === "loading" ? (
				<div
					role="status"
					aria-label="Loading notes"
					className="flex items-center gap-2 text-sm text-muted-foreground"
				>
					<Spinner />
					Loading notes…
				</div>
			) : notesState.status === "error" ? (
				<p className="text-sm text-destructive">{notesState.message}</p>
			) : notesState.notes.length === 0 ? (
				<p className="text-sm text-muted-foreground">No notes yet.</p>
			) : (
				<ul className="flex flex-col gap-3">
					{notesState.notes.map((note) => (
						<li key={note.noteId} className="flex flex-col gap-1">
							<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
								<span className="font-medium text-foreground">
									{note.authorLabel}
								</span>
								<time
									dateTime={new Date(note.createdAt).toISOString()}
									className="tabular-nums"
								>
									{formatRelativeTime(note.createdAt)}
								</time>
							</div>
							<p className="text-sm whitespace-pre-wrap wrap-break-word">
								{note.content}
							</p>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
