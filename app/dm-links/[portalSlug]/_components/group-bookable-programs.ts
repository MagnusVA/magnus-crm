export type BookableProgramEventType = {
	eventTypeConfigId: string;
	eventTypeDisplayName: string;
	bookingProgramId: string;
	bookingProgramName: string;
	bookingBaseUrl: string;
	isExtended: boolean;
	// Active teams whose DM closers get this event type. The server applies
	// the booking coverage rule (or the legacy routing rule) to fill it.
	teamIds: string[];
};

export type SchedulingMode = "normal" | "extended";

export type GroupedBookableProgram = {
	bookingProgramId: string;
	bookingProgramName: string;
	eventTypes: BookableProgramEventType[];
};

export function eventTypesForTeam(
	eventTypes: BookableProgramEventType[],
	team: { teamId: string },
) {
	return eventTypes.filter((eventType) => eventType.teamIds.includes(team.teamId));
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
