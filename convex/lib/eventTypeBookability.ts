export type CalendlySyncStatus =
  | "active"
  | "inactive"
  | "deleted"
  | "not_returned";

export type BookingUrlSource =
  | "admin_entered"
  | "imported_sheet"
  | "calendly_synced";

export type BookingProgramMappingStatus = "mapped" | "unmapped";

export type PortalReadiness =
  | "ready"
  | "missing_url"
  | "missing_current_calendly_url"
  | "unmapped_program"
  | "calendly_unavailable"
  | "hidden";

type PortalBookabilityConfig = {
  bookingBaseUrl?: string;
  bookingUrlSource?: BookingUrlSource;
  bookingProgramId?: unknown;
  bookingProgramMappingStatus?: BookingProgramMappingStatus;
  calendlySchedulingUrl?: string;
  calendlySyncStatus?: CalendlySyncStatus;
  linkPortalEnabled?: boolean;
};

export function isCalendlyBookable(config: {
  calendlySyncStatus?: CalendlySyncStatus;
}) {
  return (
    config.calendlySyncStatus === undefined ||
    config.calendlySyncStatus === "active"
  );
}

export function isPortalBookable(config: PortalBookabilityConfig) {
  const hasTrustedBaseUrl =
    config.bookingUrlSource !== "calendly_synced" ||
    Boolean(config.calendlySchedulingUrl);

  return (
    config.linkPortalEnabled === true &&
    isCalendlyBookable(config) &&
    hasTrustedBaseUrl &&
    Boolean(config.bookingBaseUrl) &&
    config.bookingProgramId !== undefined &&
    config.bookingProgramMappingStatus === "mapped"
  );
}

export function portalReadiness(
  config: PortalBookabilityConfig,
): PortalReadiness {
  if (config.linkPortalEnabled === true && !isCalendlyBookable(config)) {
    return "calendly_unavailable";
  }
  if (
    config.bookingUrlSource === "calendly_synced" &&
    !config.calendlySchedulingUrl
  ) {
    return "missing_current_calendly_url";
  }
  if (isPortalBookable(config)) {
    return "ready";
  }

  const hasMappedProgram =
    config.bookingProgramId !== undefined &&
    config.bookingProgramMappingStatus === "mapped";

  if (!config.bookingBaseUrl && hasMappedProgram) {
    return "missing_url";
  }
  if (config.bookingBaseUrl && !hasMappedProgram) {
    return "unmapped_program";
  }
  return "hidden";
}
