/**
 * Lead-level Initial Source (NIM-17): manual CTA / Inbound / WeChat
 * classification entered by DM closers in the link portal.
 */
export type LeadInitialSource = "cta" | "inbound" | "wechat";

/** Each source's label. Screens show it as plain text, not a coloured badge. */
export const INITIAL_SOURCE_META: Record<LeadInitialSource, { label: string }> = {
	cta: { label: "CTA" },
	inbound: { label: "Inbound" },
	wechat: { label: "WeChat" },
};
