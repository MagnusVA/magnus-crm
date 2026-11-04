import type { PostHog } from "posthog-js";
import { isPostHogEnabled } from "@/lib/posthog-config";

/**
 * The browser PostHog client, without `posthog-js` in any page's first load.
 *
 * `instrumentation-client.ts` imports `posthog-js` on its own chunk, then
 * calls `attachPostHog`. Calls made before that wait here and run in order
 * once it's attached. Import this module, never `posthog-js`, in app code: a
 * static import puts the whole library back in the page's first load.
 */

type Call = (client: PostHog) => void;

/** Enough for the events of a slow first load; later ones are dropped. */
const MAX_PENDING = 100;

let client: PostHog | null = null;
const pending: Call[] = [];
/** True once PostHog is attached or failed to load. */
let settled = false;
const waiters: Array<() => void> = [];

function settle() {
	settled = true;
	for (const resolve of waiters.splice(0)) resolve();
}

function run(call: Call) {
	if (!isPostHogEnabled()) return;
	if (client) {
		call(client);
		return;
	}
	if (pending.length < MAX_PENDING) pending.push(call);
}

/** Called once by `instrumentation-client.ts` after `posthog.init`. */
export function attachPostHog(instance: PostHog) {
	client = instance;
	for (const call of pending.splice(0)) call(instance);
	settle();
}

/** Called by `instrumentation-client.ts` when `posthog-js` fails to load. */
export function postHogUnavailable() {
	pending.length = 0;
	settle();
}

/**
 * Resolves once queued calls have run, or PostHog failed to load. Await it
 * before navigating away, so a queued reset isn't lost with the page.
 */
export function postHogSettled(): Promise<void> {
	if (!isPostHogEnabled() || settled) return Promise.resolve();
	return new Promise((resolve) => waiters.push(resolve));
}

const posthog = {
	capture: (...args: Parameters<PostHog["capture"]>) =>
		run((c) => {
			c.capture(...args);
		}),
	captureException: (...args: Parameters<PostHog["captureException"]>) =>
		run((c) => {
			c.captureException(...args);
		}),
	identify: (...args: Parameters<PostHog["identify"]>) =>
		run((c) => c.identify(...args)),
	group: (...args: Parameters<PostHog["group"]>) => run((c) => c.group(...args)),
	reset: (...args: Parameters<PostHog["reset"]>) => run((c) => c.reset(...args)),
	logger: {
		warn: (...args: Parameters<PostHog["logger"]["warn"]>) =>
			run((c) => c.logger.warn(...args)),
	},
};

export default posthog;
