export type BookableProgramEventType = {
	eventTypeConfigId: string;
	eventTypeDisplayName: string;
	bookingProgramId: string;
	bookingProgramName: string;
	bookingBaseUrl: string;
};

export type GroupedBookableProgram = {
	bookingProgramId: string;
	bookingProgramName: string;
	eventTypes: BookableProgramEventType[];
};

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
