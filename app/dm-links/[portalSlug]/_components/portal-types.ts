import type { MemberAvatarIdentity } from "@/app/workspace/_components/member-avatar";
import type {
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

/** What `linkPortal.portalActions.getPortalBootstrap` returns for a live session. */
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
