export type PortalReadiness =
  | "ready"
  | "missing_url"
  | "missing_current_calendly_url"
  | "unmapped_program"
  | "calendly_unavailable"
  | "hidden";

type ReadinessConfig = {
  bookingBaseUrl?: string;
  bookingUrlSource?: "admin_entered" | "imported_sheet" | "calendly_synced";
  bookingProgramId?: unknown;
  bookingProgramMappingStatus?: "mapped" | "unmapped";
  calendlySchedulingUrl?: string;
  calendlySyncStatus?: "active" | "inactive" | "deleted" | "not_returned";
  linkPortalEnabled?: boolean;
};

export const READINESS_LABEL: Record<PortalReadiness, string> = {
  ready: "Ready",
  missing_url: "Missing URL",
  missing_current_calendly_url: "Missing current Calendly URL",
  unmapped_program: "Unmapped program",
  calendly_unavailable: "Calendly unavailable",
  hidden: "Hidden",
};

export function portalReadinessFor(config: ReadinessConfig): PortalReadiness {
  const isCalendlyBookable =
    config.calendlySyncStatus === undefined ||
    config.calendlySyncStatus === "active";

  if (config.linkPortalEnabled === true && !isCalendlyBookable) {
    return "calendly_unavailable";
  }
  if (
    config.bookingUrlSource === "calendly_synced" &&
    !config.calendlySchedulingUrl
  ) {
    return "missing_current_calendly_url";
  }

  const hasMappedProgram =
    config.bookingProgramId !== undefined &&
    config.bookingProgramMappingStatus === "mapped";
  const hasTrustedBaseUrl =
    config.bookingUrlSource !== "calendly_synced" ||
    Boolean(config.calendlySchedulingUrl);

  if (
    config.linkPortalEnabled === true &&
    isCalendlyBookable &&
    hasTrustedBaseUrl &&
    config.bookingBaseUrl &&
    hasMappedProgram
  ) {
    return "ready";
  }
  if (!config.bookingBaseUrl && hasMappedProgram) {
    return "missing_url";
  }
  if (config.bookingBaseUrl && !hasMappedProgram) {
    return "unmapped_program";
  }
  return "hidden";
}

export function readinessBadgeVariant(readiness: PortalReadiness) {
  if (readiness === "ready") {
    return "secondary" as const;
  }
  if (readiness === "hidden") {
    return "outline" as const;
  }
  return "destructive" as const;
}
