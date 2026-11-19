import type { MemberAvatarIdentity } from "@/app/workspace/_components/member-avatar";
import type {
	CloserLinkCopyInput,
	CloserLinkCopyResult,
	PortalCopyInput,
	PortalCopyResult,
	PortalLeadNoteInput,
	PortalLeadNoteResult,
	PortalLeadNotesResult,
	PortalLeadProfileInput,
	PortalLeadProfileResult,
	PortalLeadSearchResult,
	PortalUnlockState,
} from "../actions";
import type { BookableProgramEventType } from "./group-bookable-programs";

/** What `linkPortal.portalQueries.getPortalBootstrap` returns for a live session. */
export type PortalBootstrap = {
	tenantName: string;
	campaignPresets: Array<{
		id: string;
		label: string;
		utmCampaign: string;
		isDefault: boolean;
	}>;
	dmClosers: Array<PortalCloser>;
	bookablePrograms: Array<BookableProgramEventType>;
	/** Closer links: phone closers whose personal link an admin put in the portal. */
	phoneClosers: Array<PortalPhoneCloser>;
	/** Closer links: the programs a closer link can be for. */
	closerLinkPrograms: Array<{ id: string; name: string }>;
};

export type PortalPhoneCloser = {
	id: string;
	displayName: string;
	identity: MemberAvatarIdentity;
};

export type PortalCloser = {
	id: string;
	displayName: string;
	identity: MemberAvatarIdentity;
	utmMedium: string;
	teamId: string;
	teamDisplayName: string;
	teamUtmSource: string;
};

export type PortalCampaign = PortalBootstrap["campaignPresets"][number];

/** What the page knows about the session from the cookie (display only; the bootstrap verified it). */
export type PortalSessionInfo = {
	/** When the session ends, in ms. */
	expiresAt: number | null;
	/** The portal's session length, in seconds. */
	ttlSeconds: number | null;
	/** A session cookie was there but no longer works (expired, rotated, or the portal is off). */
	ended: boolean;
};

/** The server actions the page hands to the client. */
export type PortalActions = {
	unlockPortal: (
		portalSlug: string,
		prevState: PortalUnlockState,
		formData: FormData,
	) => Promise<PortalUnlockState>;
	logoutPortal: (portalSlug: string, formData: FormData) => Promise<void>;
	recordPortalCopy: (
		portalSlug: string,
		input: PortalCopyInput,
	) => Promise<PortalCopyResult>;
	recordCloserLinkCopy: (
		portalSlug: string,
		input: CloserLinkCopyInput,
	) => Promise<CloserLinkCopyResult>;
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
