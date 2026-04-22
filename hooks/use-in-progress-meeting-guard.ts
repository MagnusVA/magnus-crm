"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Hard-blocks navigation away from the meeting detail page while a meeting is
 * actively in progress (closer started but has not pressed "End Meeting").
 *
 * Protects three classes of navigation:
 *   1. `beforeunload`           → tab close, refresh, URL-bar change, browser back off the app.
 *                                   The browser's built-in prompt is the hard stop.
 *   2. Document click capture   → any in-app `<a href>` click (sidebar, banners, etc.) is
 *                                   fully cancelled; the warning dialog is shown instead.
 *   3. `blockBack()` helper     → wrap in-page `router.back()` / `router.push()` calls so
 *                                   they show the warning instead of navigating.
 *
 * There is no "leave anyway" path — the closer must end the meeting first.
 *
 * The guard auto-disarms as soon as `active` becomes false (e.g. after the
 * closer ends the meeting and `meeting.status` transitions to "completed").
 */
export function useInProgressMeetingGuard({ active }: { active: boolean }) {
	const [warningOpen, setWarningOpen] = useState(false);

	// Ref mirror so the click-capture listener (installed once) always sees
	// the latest `active` state without re-binding on every render.
	const activeRef = useRef(active);
	useEffect(() => {
		activeRef.current = active;
	}, [active]);

	// (1) beforeunload — tab close / refresh / URL bar / leaving the app.
	useEffect(() => {
		if (!active) return;
		const handler = (e: BeforeUnloadEvent) => {
			e.preventDefault();
			// Legacy Chrome/Safari still require returnValue to be set.
			e.returnValue = "";
		};
		window.addEventListener("beforeunload", handler);
		return () => {
			window.removeEventListener("beforeunload", handler);
		};
	}, [active]);

	// (2) Document-level capture-phase click interceptor for in-app `<a>` nav.
	useEffect(() => {
		const handler = (event: MouseEvent) => {
			if (!activeRef.current) return;
			if (event.defaultPrevented) return;
			if (event.button !== 0) return; // primary click only
			if (
				event.metaKey ||
				event.ctrlKey ||
				event.shiftKey ||
				event.altKey
			) {
				return; // let "open in new tab" etc. through
			}

			const target = event.target;
			if (!(target instanceof Element)) return;
			const link = target.closest("a");
			if (!link) return;

			const href = link.getAttribute("href");
			if (!href) return;

			// Respect explicit download / new-tab / non-HTTP schemes.
			if (link.target === "_blank") return;
			if (link.hasAttribute("download")) return;
			if (
				href.startsWith("mailto:") ||
				href.startsWith("tel:") ||
				href.startsWith("javascript:")
			) {
				return;
			}

			let url: URL;
			try {
				url = new URL(href, window.location.href);
			} catch {
				return;
			}

			// Cross-origin → let the browser handle it (beforeunload will fire).
			if (url.origin !== window.location.origin) return;

			// Same-URL hash anchor (e.g. "#top") → not a navigation.
			const sameUrl =
				url.pathname === window.location.pathname &&
				url.search === window.location.search;
			if (sameUrl && url.hash) return;

			event.preventDefault();
			event.stopPropagation();
			setWarningOpen(true);
		};
		document.addEventListener("click", handler, true);
		return () => {
			document.removeEventListener("click", handler, true);
		};
	}, []);

	// (3) Manual wrapper for in-page `router.back()` / `router.push()` buttons.
	// When active, shows the warning and drops the navigation; when inactive,
	// runs it normally.
	const blockBack = useCallback(
		(navigate: () => void) => {
			if (!active) {
				navigate();
				return;
			}
			setWarningOpen(true);
		},
		[active],
	);

	const dismissWarning = useCallback(() => {
		setWarningOpen(false);
	}, []);

	return {
		blockBack,
		warningOpen,
		dismissWarning,
	};
}
