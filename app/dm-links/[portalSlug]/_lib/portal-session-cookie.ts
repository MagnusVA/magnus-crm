const PORTAL_SLUG_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function normalizePortalSlugParam(portalSlug: string) {
	const normalized = portalSlug.trim();
	return PORTAL_SLUG_PATTERN.test(normalized) ? normalized : null;
}

export function portalSessionCookieName(portalSlug: string) {
	return `dm_link_portal_${portalSlug}`;
}

export function portalSessionCookiePath(portalSlug: string) {
	return `/dm-links/${portalSlug}`;
}
