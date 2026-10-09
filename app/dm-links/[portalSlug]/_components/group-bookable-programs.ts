export type BookableProgramEventType = {
	eventTypeConfigId: string;
	eventTypeDisplayName: string;
	bookingProgramId: string;
	bookingProgramName: string;
	bookingBaseUrl: string;
	isExtended: boolean;
	// No team is routed to this event type.
	isShared: boolean;
	// Teams whose program and mode route points at this event type.
	routedTeamIds: string[];
};

export type SchedulingMode = "normal" | "extended";

export type GroupedBookableProgram = {
	bookingProgramId: string;
	bookingProgramName: string;
	eventTypes: BookableProgramEventType[];
};

// A team with routes sees only its routed event types; a team without routes
// sees the shared ones. Mirrors canTeamUseEventType on the server.
export function eventTypesForTeam(
	eventTypes: BookableProgramEventType[],
	team: { teamId: string; teamHasEventTypeRoutes: boolean },
) {
	return eventTypes.filter((eventType) =>
		team.teamHasEventTypeRoutes
			? eventType.routedTeamIds.includes(team.teamId)
			: eventType.isShared,
	);
}

export function filterEventTypesBySchedulingMode(
	eventTypes: BookableProgramEventType[],
	mode: SchedulingMode,
) {
	return eventTypes.filter((eventType) =>
		mode === "extended" ? eventType.isExtended : !eventType.isExtended,
	);
}

export function programHasSchedulingMode(
	eventTypes: BookableProgramEventType[],
	mode: SchedulingMode,
) {
	return filterEventTypesBySchedulingMode(eventTypes, mode).length > 0;
}

export function groupBookablePrograms(
	programs: BookableProgramEventType[],
): GroupedBookableProgram[] {
	const byProgramId = new Map<string, GroupedBookableProgram>();

	for (const eventType of programs) {
		const existing = byProgramId.get(eventType.bookingProgramId);
		if (existing) {
			existing.eventTypes.push(eventType);
			continue;
		}

		byProgramId.set(eventType.bookingProgramId, {
			bookingProgramId: eventType.bookingProgramId,
			bookingProgramName: eventType.bookingProgramName,
			eventTypes: [eventType],
		});
	}

	return [...byProgramId.values()].sort((left, right) =>
		left.bookingProgramName.localeCompare(right.bookingProgramName),
	);
}

export function formatEventTypeSummary(eventTypes: BookableProgramEventType[]) {
	if (eventTypes.length === 1) {
		return eventTypes[0]?.eventTypeDisplayName ?? "";
	}

	return `${eventTypes.length} event types: ${eventTypes
		.map((eventType) => eventType.eventTypeDisplayName)
		.join(", ")}`;
}
