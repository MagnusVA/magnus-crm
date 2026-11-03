"use client";

import { useActionState } from "react";
import type { PortalUnlockState } from "../actions";
import { Spinner } from "@/components/ui/spinner";
import {
	formatSessionLength,
	useRememberedSessionSeconds,
	useRememberedTenantName,
} from "./device-memory";
import { PORTAL_BRAND, PortalColumn } from "./portal-ui";
import type { PortalActions, PortalSessionInfo } from "./portal-types";

const initialUnlockState: PortalUnlockState = { status: "idle" };

/**
 * Concept C's password screen: dark, phone-first, one field. The unlock is
 * the existing server action (rate-limited and hashed in Convex); on success
 * it sets the httpOnly session cookie and reloads the page.
 */
export function PortalPasswordScreen({
	portalSlug,
	session,
	unlockPortal,
}: {
	portalSlug: string;
	session: PortalSessionInfo;
	unlockPortal: PortalActions["unlockPortal"];
}) {
	const [state, formAction, isPending] = useActionState(
		unlockPortal.bind(null, portalSlug),
		initialUnlockState,
	);
	const [rememberedSeconds] = useRememberedSessionSeconds(portalSlug);
	const [tenantName] = useRememberedTenantName(portalSlug);
	const sessionSeconds = session.ttlSeconds ?? rememberedSeconds;
	const errorId = "portal-password-error";
	const hasError = state.status === "error";

	return (
		<main className="min-h-dvh bg-board text-board-foreground">
			<PortalColumn className="px-5 pt-[max(30px,8vh)] pb-10">
				<div className={PORTAL_BRAND}>{tenantName ?? "Magnus"}</div>
				<h1 className="mt-4 text-[22px] leading-tight font-semibold">
					Booking links
				</h1>
				{session.ended ? (
					<p className="mt-3 rounded-[7px] border border-board-foreground/15 bg-board-raised px-3 py-2 text-[13px] text-board-foreground">
						You were signed out. Enter the password again; if it doesn’t work,
						ask your admin for the new one.
					</p>
				) : null}
				<p className="mt-3 text-[13px] text-board-muted">
					Enter the password your admin shared.
				</p>
				<form action={formAction} className="mt-3 flex flex-col gap-3">
					<input
						type="text"
						name="username"
						autoComplete="username"
						value={portalSlug}
						readOnly
						hidden
					/>
					<input
						id="portal-password"
						name="password"
						type="password"
						autoComplete="current-password"
						required
						autoFocus
						placeholder="Portal password"
						aria-label="Portal password"
						aria-invalid={hasError}
						aria-describedby={hasError ? errorId : undefined}
						disabled={isPending}
						className="h-[42px] w-full rounded-[7px] border border-board-foreground/[0.18] bg-board-raised px-2.5 text-base text-board-foreground outline-none placeholder:text-board-muted/80 focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/30 disabled:opacity-60 aria-invalid:border-board-danger sm:text-[14px]"
					/>
					{hasError ? (
						<p
							id={errorId}
							aria-live="polite"
							className="-mt-1 text-[13px] text-board-danger"
						>
							{state.message}
						</p>
					) : null}
					<button
						type="submit"
						disabled={isPending}
						className="inline-flex h-10 items-center justify-center gap-2 rounded-[7px] bg-primary text-[14px] font-semibold text-board outline-none hover:bg-primary/85 focus-visible:ring-3 focus-visible:ring-primary/40 disabled:opacity-70"
					>
						{isPending ? <Spinner /> : null}
						{isPending ? "Checking…" : "Enter"}
					</button>
				</form>
				<p className="mt-3 text-[12px] text-board-muted">
					{sessionSeconds
						? `Stays signed in for ${formatSessionLength(sessionSeconds)} on this phone.`
						: "Stays signed in on this phone for the session length your admin set."}
				</p>
			</PortalColumn>
		</main>
	);
}
