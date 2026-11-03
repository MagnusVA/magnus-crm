"use client";

import { useCallback, useSyncExternalStore } from "react";

// What the portal remembers on this device, per portal slug: who the closer
// is (so "Who are you?" is skipped next time) and the session length (so the
// password screen can say how long it stays signed in, and under whose
// name). Nothing secret: the slug is already in the URL.

const CHANGE_EVENT = "dm-links:device-memory";

function storageKey(portalSlug: string, name: "closer" | "session-seconds" | "tenant") {
	return `dm-links:${portalSlug}:${name}`;
}

// This page's own copy of what it wrote, so a choice holds for this visit
// even when localStorage refuses the write (private mode, storage full).
const memory = new Map<string, string | null>();

function read(key: string) {
	if (memory.has(key)) return memory.get(key) ?? null;
	try {
		return window.localStorage.getItem(key);
	} catch {
		return null;
	}
}

function write(key: string, value: string | null) {
	memory.set(key, value);
	try {
		if (value === null) window.localStorage.removeItem(key);
		else window.localStorage.setItem(key, value);
	} catch {
		// Private mode or storage full: the portal still works, it just forgets.
	}
	window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(onChange: () => void) {
	// Another tab changed storage: its value wins over this page's copy.
	const onStorage = (event: StorageEvent) => {
		if (event.key === null) memory.clear();
		else memory.delete(event.key);
		onChange();
	};
	window.addEventListener("storage", onStorage);
	window.addEventListener(CHANGE_EVENT, onChange);
	return () => {
		window.removeEventListener("storage", onStorage);
		window.removeEventListener(CHANGE_EVENT, onChange);
	};
}

const noopSubscribe = () => () => {};

/** False during the server render and hydration, true after. */
export function useHydrated() {
	return useSyncExternalStore(
		noopSubscribe,
		() => true,
		() => false,
	);
}

function useStoredValue(key: string) {
	const value = useSyncExternalStore(
		subscribe,
		() => read(key),
		() => null,
	);
	const set = useCallback((next: string | null) => write(key, next), [key]);
	return [value, set] as const;
}

export function useRememberedCloser(portalSlug: string) {
	return useStoredValue(storageKey(portalSlug, "closer"));
}

export function useRememberedTenantName(portalSlug: string) {
	return useStoredValue(storageKey(portalSlug, "tenant"));
}

export function useRememberedSessionSeconds(portalSlug: string) {
	const [value, set] = useStoredValue(storageKey(portalSlug, "session-seconds"));
	const seconds = value === null ? null : Number(value);
	return [
		seconds !== null && Number.isFinite(seconds) && seconds > 0 ? seconds : null,
		set,
	] as const;
}

export function formatSessionLength(seconds: number) {
	if (seconds < 3600) {
		const minutes = Math.round(seconds / 60);
		return `${minutes} minute${minutes === 1 ? "" : "s"}`;
	}
	const hours = Math.round((seconds / 3600) * 4) / 4;
	return `${hours} hour${hours === 1 ? "" : "s"}`;
}
