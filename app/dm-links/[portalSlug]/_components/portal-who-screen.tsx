"use client";

import { useState } from "react";
import { SearchIcon } from "lucide-react";
import { closersByTeam } from "./link-sheet-model";
import { PortalHeader, SignOutButton } from "./portal-header";
import type { PortalCloser } from "./portal-types";
import { CloserInitials, PORTAL_LABEL, PortalColumn } from "./portal-ui";

/**
 * "Who are you?": pick yourself once, grouped by team. The choice is
 * remembered on this device, so the next visit goes straight to the links.
 */
export function PortalWhoScreen({
	tenantName,
	closers,
	onPick,
	signOut,
}: {
	tenantName: string;
	closers: PortalCloser[];
	onPick: (closer: PortalCloser) => void;
	signOut: (formData: FormData) => Promise<void>;
}) {
	const [search, setSearch] = useState("");
	const teams = closersByTeam(closers, search);

	return (
		<main className="flex min-h-dvh flex-col bg-background">
			<PortalHeader tenantName={tenantName} action={<SignOutButton action={signOut} />}>
				<h1 className="mt-1.5 text-[19px] leading-[1.1] font-semibold">Who are you?</h1>
				<p className="mt-0.5 text-[12px] text-board-muted">
					We’ll remember you on this phone.
				</p>
				{closers.length > 0 ? (
					<div className="relative mt-2.5">
						<SearchIcon
							aria-hidden
							className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-board-muted"
						/>
						<input
							type="search"
							value={search}
							onChange={(event) => setSearch(event.target.value)}
							placeholder="Search your name"
							aria-label="Search your name"
							className="h-9 w-full rounded-[7px] border border-board-foreground/[0.18] bg-board-raised pr-2.5 pl-8 text-base text-board-foreground outline-none placeholder:text-board-muted/80 focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/30 sm:text-[14px]"
						/>
					</div>
				) : null}
			</PortalHeader>

			<PortalColumn className="flex-1 pb-6">
				{closers.length === 0 ? (
					<p className="px-[18px] py-7 text-center text-[13px] text-muted-foreground">
						No DM closers are set up yet.
						<br />
						Ask your admin to add you.
					</p>
				) : teams.length === 0 ? (
					<p className="px-[18px] py-7 text-center text-[13px] text-muted-foreground">
						No one by that name.
					</p>
				) : (
					teams.map((team) => (
						<section key={team.teamId} aria-labelledby={`who-team-${team.teamId}`}>
							<h2 id={`who-team-${team.teamId}`} className={`${PORTAL_LABEL} px-3.5 pt-3 pb-1.5`}>
								{team.teamName}
							</h2>
							<ul className="border-t border-border">
								{team.closers.map((closer) => (
									<li key={closer.id}>
										<button
											type="button"
											onClick={() => onPick(closer)}
											className="flex min-h-11 w-full items-center gap-2.5 border-b border-border bg-card px-3.5 py-2 text-left text-[14px] outline-none hover:bg-background focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
										>
											<CloserInitials name={closer.displayName} />
											<span className="min-w-0 truncate">{closer.displayName}</span>
										</button>
									</li>
								))}
							</ul>
						</section>
					))
				)}
			</PortalColumn>
		</main>
	);
}
