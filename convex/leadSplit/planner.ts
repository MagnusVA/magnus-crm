import type { Doc, Id } from "../_generated/dataModel";
import { exceptionAllows } from "../lib/opportunityActivity";
import type { OpportunityStatus } from "../lib/statusTransitions";
import {
  clusterMeetings,
  compareMeetings,
  firstMeetingOfPersonKey,
  personKeyOf,
  possibleSamePersonPairs,
  sharedEmailKeys,
} from "./clustering";
import {
  hasPlaceholderKey,
  isPlaceholderIdentifier,
  keyMeetings,
  type LeadEvidence,
  type MeetingKeys,
} from "./evidence";
import {
  emailKey,
  identifierKey,
  isEmailKey,
  isPhoneKey,
  keyToIdentifier,
  socialKey,
  type IdentityKey,
} from "./identityKeys";
import type {
  LeadSplitFlag,
  LeadSplitFlagDetail,
  LeadSplitOpportunityPlan,
  LeadSplitOverrides,
} from "./schema";

// Rules from docs/plans/polluted-lead-split.md §4 and §5.4, with the
// decisions recorded in §7.

/**
 * Other leads a moved person's keys already resolve to (rule 3), and which of
 * them are being split themselves.
 */
export type MergeTargetLookup = (
  keys: IdentityKey[],
) => Promise<{ leadIds: Id<"leads">[]; inPlanLeadIds: Id<"leads">[] }>;

export type PlannedPerson = {
  personKey: string;
  candidateKeys: string[];
  role: "original" | "new" | "merge_into";
  targetLeadId?: Id<"leads">;
  mergeCandidateLeadIds: Id<"leads">[];
  meetingIds: Id<"meetings">[];
  identifierIds: Id<"leadIdentifiers">[];
  slackEventIds: Id<"slackQualificationEvents">[];
  opportunityPlan: LeadSplitOpportunityPlan[];
  canonical: {
    email?: string;
    fullName?: string;
    phone?: string;
    customFieldsMeetingId?: Id<"meetings">;
  };
};

export type LeadSplitPlanResult = {
  tier: "A" | "B";
  /** In order of each person's first meeting. */
  persons: PlannedPerson[];
  flags: LeadSplitFlag[];
  flagDetails: LeadSplitFlagDetail[];
  placeholderIdentifierIds: Id<"leadIdentifiers">[];
  unattributedMeetingIds: Id<"meetings">[];
  slackFieldsPersonKey?: string;
};

type WorkingPerson = {
  candidateKeys: string[];
  meetingIds: Id<"meetings">[];
  keys: Set<IdentityKey>;
  names: string[];
  identifierIds: Id<"leadIdentifiers">[];
  slackEventIds: Id<"slackQualificationEvents">[];
  opportunityPlan: LeadSplitOpportunityPlan[];
};

class Flags {
  private readonly details: LeadSplitFlagDetail[] = [];
  private readonly seen = new Set<string>();
  add(detail: LeadSplitFlagDetail): void {
    const id = JSON.stringify(detail);
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.details.push(detail);
  }
  result(): { flags: LeadSplitFlag[]; flagDetails: LeadSplitFlagDetail[] } {
    return {
      flags: [...new Set(this.details.map((detail) => detail.flag))].sort(),
      flagDetails: this.details,
    };
  }
}

// Fields Slack qualification or the DM portal wrote onto the lead (O5).
const SLACK_AND_PORTAL_FIELDS = [
  "country",
  "leadType",
  "initialSource",
  "selfReportedIncome",
] as const;

/**
 * Computes who the people behind one lead are and where each of their
 * meetings, deals, identifiers and Slack events goes. Pure apart from
 * `lookupMergeTargets`.
 */
export async function planLeadSplit(
  evidence: LeadEvidence,
  options: {
    overrides?: LeadSplitOverrides;
    lookupMergeTargets: MergeTargetLookup;
  },
): Promise<LeadSplitPlanResult> {
  const { overrides } = options;
  const flags = new Flags();
  if (evidence.boundsHit) flags.add({ flag: "bounds_exceeded" });

  const keyed = keyMeetings(evidence, true);
  const meetingKeys = new Map(keyed.map((meeting) => [meeting.meetingId, meeting]));
  const inBookingOrder = (ids: Iterable<Id<"meetings">>) =>
    [...ids].sort((a, b) => compareMeetings(meetingKeys.get(a)!, meetingKeys.get(b)!));

  for (const meeting of keyed) {
    if (!evidence.snapshots.has(meeting.meetingId)) {
      flags.add({ flag: "snapshot_missing", meetingId: meeting.meetingId });
    } else if (
      meeting.snapshotEmail &&
      meeting.sourcedEmails.length > 0 &&
      !meeting.sourcedEmails.includes(meeting.snapshotEmail)
    ) {
      flags.add({ flag: "snapshot_disagrees", meetingId: meeting.meetingId });
    }
  }

  // Candidate persons: the clusters, after any meetings a reviewer separated.
  const base = clusterMeetings(keyed);
  let groups = base.clusters.map((cluster) => cluster.meetingIds);
  let unattributed = base.unattributedMeetingIds;
  for (const group of overrides?.separate ?? []) {
    if (group.length === 0 || group.some((id) => !meetingKeys.has(id))) {
      flags.add({ flag: "stale_override" });
      continue;
    }
    const pulled = new Set(group);
    groups = groups
      .map((ids) => ids.filter((id) => !pulled.has(id)))
      .filter((ids) => ids.length > 0);
    unattributed = unattributed.filter((id) => !pulled.has(id));
    groups.push(inBookingOrder(pulled));
  }
  groups.sort((a, b) => compareMeetings(meetingKeys.get(a[0])!, meetingKeys.get(b[0])!));

  const toPerson = (meetingIds: Id<"meetings">[], candidateKeys: string[]): WorkingPerson => {
    const meetings = meetingIds.map((id) => meetingKeys.get(id)!);
    return {
      candidateKeys,
      meetingIds,
      keys: new Set(meetings.flatMap((meeting) => meeting.keys)),
      names: meetings.flatMap((meeting) => (meeting.name ? [meeting.name] : [])),
      identifierIds: [],
      slackEventIds: [],
      opportunityPlan: [],
    };
  };
  // Candidate keys stay in booking order, so the first one is the person's key.
  const mergePersons = (into: WorkingPerson, from: WorkingPerson): WorkingPerson =>
    toPerson(
      inBookingOrder([...into.meetingIds, ...from.meetingIds]),
      [...into.candidateKeys, ...from.candidateKeys].sort((a, b) =>
        compareMeetings(
          meetingKeys.get(firstMeetingOfPersonKey(a))!,
          meetingKeys.get(firstMeetingOfPersonKey(b))!,
        ),
      ),
    );

  let persons = groups.map((ids) => toPerson(ids, [personKeyOf({ meetingIds: ids })]));

  for (const group of overrides?.merges ?? []) {
    const members = group.map((key) =>
      persons.find((person) => person.candidateKeys.includes(key)),
    );
    if (members.length === 0 || members.some((member) => member === undefined)) {
      flags.add({ flag: "stale_override", personKeys: group });
      continue;
    }
    const unique = [...new Set(members as WorkingPerson[])];
    const merged = unique.slice(1).reduce(mergePersons, unique[0]);
    persons = [...persons.filter((person) => !unique.includes(person)), merged];
  }
  const sortPersons = () =>
    persons.sort((a, b) =>
      compareMeetings(meetingKeys.get(a.meetingIds[0])!, meetingKeys.get(b.meetingIds[0])!),
    );
  sortPersons();

  const personOfMeeting = new Map<Id<"meetings">, WorkingPerson>();
  const indexMeetings = () => {
    personOfMeeting.clear();
    for (const person of persons) {
      for (const id of person.meetingIds) personOfMeeting.set(id, person);
    }
  };
  indexMeetings();

  // A meeting with no key joins the person who owns the rest of its deal.
  const unplaced: Id<"meetings">[] = [];
  for (const id of unattributed) {
    flags.add({ flag: "unattributed_meeting", meetingId: id });
    const opportunityId = meetingKeys.get(id)!.opportunityId;
    const owners = new Set(
      keyed
        .filter((meeting) => meeting.opportunityId === opportunityId)
        .flatMap((meeting) => personOfMeeting.get(meeting.meetingId) ?? []),
    );
    if (owners.size === 1) {
      const [owner] = owners;
      owner.meetingIds = inBookingOrder([...owner.meetingIds, id]);
      personOfMeeting.set(id, owner);
    } else {
      unplaced.push(id);
    }
  }

  const tier = hasPlaceholderKey(evidence) ? "A" : "B";
  if (persons.length === 0) {
    return {
      tier,
      persons: [],
      ...flags.result(),
      placeholderIdentifierIds: evidence.identifiers
        .filter(isPlaceholderIdentifier)
        .map((identifier) => identifier._id),
      unattributedMeetingIds: unattributed,
    };
  }

  const holdersOf = (key: IdentityKey | undefined) =>
    key ? persons.filter((person) => person.keys.has(key)) : [];
  const slackEventsByOpportunity = new Map<Id<"opportunities">, Doc<"slackQualificationEvents">[]>();
  for (const event of [...evidence.slackEvents].sort((a, b) => a.submittedAt - b.submittedAt)) {
    if (!event.opportunityId) continue;
    slackEventsByOpportunity.set(event.opportunityId, [
      ...(slackEventsByOpportunity.get(event.opportunityId) ?? []),
      event,
    ]);
  }
  // The person a Slack event's handle names (decision on Q3).
  const slackPerson = (opportunityId: Id<"opportunities">) => {
    const [event] = slackEventsByOpportunity.get(opportunityId) ?? [];
    const holders = holdersOf(event ? socialKey(event.platform, event.handleSnapshot) : undefined);
    return holders.length === 1 ? holders[0] : undefined;
  };
  const meetingsOn = (opportunityId: Id<"opportunities">) =>
    keyed.filter(
      (meeting) => meeting.opportunityId === opportunityId && personOfMeeting.has(meeting.meetingId),
    );
  // O1: who keeps an opportunity's document.
  const keeperOf = (opportunity: Doc<"opportunities">): WorkingPerson | undefined => {
    const meetings = meetingsOn(opportunity._id);
    if (meetings.length === 0) return slackPerson(opportunity._id);
    if ((opportunity.source ?? "calendly") === "calendly") {
      return personOfMeeting.get(meetings[meetings.length - 1].meetingId);
    }
    const named = slackPerson(opportunity._id);
    const onDeal = new Set(meetings.map((meeting) => personOfMeeting.get(meeting.meetingId)));
    return named && onDeal.has(named) ? named : personOfMeeting.get(meetings[0].meetingId);
  };
  const opportunities = new Map(evidence.opportunities.map((opportunity) => [opportunity._id, opportunity]));

  // Rule 2, amended: on a converted lead the customer's person stays, so the
  // customer never moves (decision on Q5).
  let original: WorkingPerson | undefined;
  if (overrides?.originalPersonKey) {
    original = persons.find((person) => person.candidateKeys.includes(overrides.originalPersonKey!));
    if (!original) {
      flags.add({ flag: "stale_override", personKeys: [overrides.originalPersonKey] });
    }
  }
  const customers = [...evidence.customers].sort((a, b) => a.createdAt - b.createdAt);
  if (customers.length > 1) flags.add({ flag: "customer_review" });
  const [customer] = customers;
  if (!original && customer) {
    const winningOpportunity = opportunities.get(customer.winningOpportunityId);
    original =
      (customer.winningMeetingId && personOfMeeting.get(customer.winningMeetingId)) ||
      (winningOpportunity && keeperOf(winningOpportunity));
    if (!original) {
      flags.add({ flag: "customer_review", opportunityId: customer.winningOpportunityId });
    }
  }
  if (!original) {
    const [earliest] = evidence.identifiers
      .filter(
        (identifier) =>
          identifier.sourceMeetingId &&
          personOfMeeting.has(identifier.sourceMeetingId) &&
          !isPlaceholderIdentifier(identifier),
      )
      .sort((a, b) => a.createdAt - b.createdAt || a._creationTime - b._creationTime);
    original = earliest ? personOfMeeting.get(earliest.sourceMeetingId!) : persons[0];
  }

  for (const key of overrides?.skips ?? []) {
    const skipped = persons.find((person) => person.candidateKeys.includes(key));
    if (!skipped) {
      flags.add({ flag: "stale_override", personKeys: [key] });
      continue;
    }
    if (skipped === original) continue;
    const merged = mergePersons(original!, skipped);
    persons = [...persons.filter((person) => person !== original && person !== skipped), merged];
    original = merged;
  }
  const originalPerson = original!;
  sortPersons();
  indexMeetings();
  for (const id of unplaced) {
    originalPerson.meetingIds = inBookingOrder([...originalPerson.meetingIds, id]);
    personOfMeeting.set(id, originalPerson);
  }

  // Not the first meeting: a meeting without keys may have joined the person.
  const personKey = (person: WorkingPerson) => person.candidateKeys[0];
  if (customer) {
    const winningOpportunity = opportunities.get(customer.winningOpportunityId);
    const keeper = winningOpportunity && keeperOf(winningOpportunity);
    const winner = customer.winningMeetingId && personOfMeeting.get(customer.winningMeetingId);
    if ((keeper && keeper !== originalPerson) || (winner && winner !== originalPerson)) {
      flags.add({
        flag: "winning_opportunity_mismatch",
        opportunityId: customer.winningOpportunityId,
      });
    }
  }

  // A shared email stays with the original when they used it, otherwise
  // with whoever booked with it first. Nobody else gets it (decision on Q5).
  const firstUse = (person: WorkingPerson, key: IdentityKey) =>
    person.meetingIds.map((id) => meetingKeys.get(id)!).find((meeting) => meeting.keys.includes(key))!;
  const emailOwners = new Map<IdentityKey, WorkingPerson>();
  for (const { key, clusters } of sharedEmailKeys(persons.map((person) => ({ keys: [...person.keys] })))) {
    const holders = clusters.map((index) => persons[index]);
    const firstBooker = holders.reduce((a, b) =>
      compareMeetings(firstUse(a, key), firstUse(b, key)) <= 0 ? a : b,
    );
    emailOwners.set(key, holders.includes(originalPerson) ? originalPerson : firstBooker);
    flags.add({ flag: "shared_email", personKeys: holders.map(personKey) });
  }
  const ownsKey = (person: WorkingPerson, key: IdentityKey) =>
    (emailOwners.get(key) ?? person) === person;
  for (const [i, j] of possibleSamePersonPairs(
    persons.map((person) => ({ meetingIds: person.meetingIds, keys: [...person.keys], names: person.names })),
  )) {
    flags.add({ flag: "possible_same_person", personKeys: [personKey(persons[i]), personKey(persons[j])] });
  }

  // O1 and O2: each deal's document, and the status each person's part gets.
  const statusFromMeeting = (
    meeting: MeetingKeys,
    opportunity: Doc<"opportunities">,
  ): OpportunityStatus => {
    if (meeting.status === "completed") {
      flags.add({ flag: "outcome_review", opportunityId: opportunity._id });
      return opportunity.status;
    }
    return meeting.status;
  };
  const documentOwners = new Map<Id<"opportunities">, WorkingPerson>();
  for (const opportunity of evidence.opportunities) {
    const meetings = meetingsOn(opportunity._id);
    const onDeal = [...new Set(meetings.map((meeting) => personOfMeeting.get(meeting.meetingId)!))];
    if (onDeal.length <= 1) {
      const owner = onDeal[0] ?? slackPerson(opportunity._id) ?? originalPerson;
      documentOwners.set(opportunity._id, owner);
      owner.opportunityPlan.push({
        opportunityId: opportunity._id,
        kind: "whole",
        statusAtBuild: opportunity.status,
        meetingIds: meetings.map((meeting) => meeting.meetingId),
        status: opportunity.status,
        inheritsOutcome: false,
      });
      continue;
    }

    const isCalendly = (opportunity.source ?? "calendly") === "calendly";
    const latest = personOfMeeting.get(meetings[meetings.length - 1].meetingId)!;
    const keeper = keeperOf(opportunity)!;
    documentOwners.set(opportunity._id, keeper);
    for (const person of onDeal) {
      const own = meetings.filter((meeting) => personOfMeeting.get(meeting.meetingId) === person);
      const ownLatest = own[own.length - 1];
      if (person === keeper) {
        const status =
          isCalendly || person === latest ? opportunity.status : statusFromMeeting(ownLatest, opportunity);
        // Only the lead_split move is allowed, even where the state machine
        // would accept another one: the document's other fields belong to its
        // current status.
        if (status !== opportunity.status && !exceptionAllows("lead_split", opportunity.status, status)) {
          flags.add({ flag: "outcome_review", opportunityId: opportunity._id });
        }
        person.opportunityPlan.push({
          opportunityId: opportunity._id,
          kind: "keep_document",
          statusAtBuild: opportunity.status,
          meetingIds: own.map((meeting) => meeting.meetingId),
          status,
          inheritsOutcome: false,
        });
      } else {
        const inheritsOutcome = !isCalendly && person === latest;
        person.opportunityPlan.push({
          opportunityId: opportunity._id,
          kind: "split_new",
          statusAtBuild: opportunity.status,
          meetingIds: own.map((meeting) => meeting.meetingId),
          status: inheritsOutcome ? opportunity.status : statusFromMeeting(ownLatest, opportunity),
          inheritsOutcome,
        });
      }
    }
    // Payments and follow-ups stay on the document, so its outcome can't
    // leave without them.
    if (
      !isCalendly &&
      keeper !== latest &&
      (opportunity.status === "payment_received" ||
        evidence.payments.some((payment) => payment.opportunityId === opportunity._id) ||
        evidence.followUps.some((followUp) => followUp.opportunityId === opportunity._id))
    ) {
      flags.add({ flag: "outcome_review", opportunityId: opportunity._id });
    }
    for (const followUp of evidence.followUps) {
      if (followUp.opportunityId !== opportunity._id) continue;
      const before = meetings.filter((meeting) => meeting.scheduledAt <= followUp.createdAt).pop();
      const after = meetings.find((meeting) => meeting.createdAt >= followUp.createdAt);
      if (
        before &&
        after &&
        personOfMeeting.get(before.meetingId) !== personOfMeeting.get(after.meetingId)
      ) {
        flags.add({ flag: "followup_between_people", opportunityId: opportunity._id });
      }
    }
  }

  // Rule 4: identifiers.
  const placeholderIdentifierIds: Id<"leadIdentifiers">[] = [];
  for (const identifier of evidence.identifiers) {
    const key = identifierKey(identifier);
    if (!key) {
      placeholderIdentifierIds.push(identifier._id);
      continue;
    }
    const sourced = identifier.sourceMeetingId && personOfMeeting.get(identifier.sourceMeetingId);
    const holders = holdersOf(key);
    const owner =
      emailOwners.get(key) ?? (sourced || (holders.length === 1 ? holders[0] : originalPerson));
    owner.identifierIds.push(identifier._id);
  }

  // O7: Slack events follow the person their handle names. An event on a
  // Slack or side-deal document stays with the document (O1).
  for (const event of evidence.slackEvents) {
    const holders = holdersOf(socialKey(event.platform, event.handleSnapshot));
    const opportunity = event.opportunityId ? opportunities.get(event.opportunityId) : undefined;
    const documentOwner =
      opportunity && (opportunity.source ?? "calendly") !== "calendly"
        ? documentOwners.get(opportunity._id)
        : undefined;
    if (documentOwner && !holders.includes(documentOwner)) {
      flags.add({ flag: "slack_event_mismatch", opportunityId: opportunity!._id });
    }
    const owner =
      documentOwner ??
      (holders.includes(originalPerson) ? originalPerson : (holders[0] ?? originalPerson));
    owner.slackEventIds.push(event._id);
  }
  let slackFieldsPersonKey: string | undefined;
  if (persons.length > 1 && SLACK_AND_PORTAL_FIELDS.some((field) => evidence.lead[field] !== undefined)) {
    flags.add({ flag: "slack_fields_review" });
    const latestEvent = [...evidence.slackEvents].sort((a, b) => b.submittedAt - a.submittedAt)[0];
    const holder = latestEvent
      ? persons.find((person) => person.slackEventIds.includes(latestEvent._id))
      : undefined;
    slackFieldsPersonKey = personKey(holder ?? originalPerson);
  }

  const identifiersById = new Map(evidence.identifiers.map((identifier) => [identifier._id, identifier]));
  const canonicalFor = (person: WorkingPerson): PlannedPerson["canonical"] => {
    const meetings = person.meetingIds.map((id) => meetingKeys.get(id)!);
    const assigned = person.identifierIds
      .map((id) => identifiersById.get(id)!)
      .sort((a, b) => a.createdAt - b.createdAt);
    // Oldest first, so the last match is the latest value.
    const usableKeys = [
      ...assigned.flatMap((identifier) => identifierKey(identifier) ?? []),
      ...meetings.flatMap((meeting) => meeting.keys),
    ].filter((key) => ownsKey(person, key));
    const leadEmailKey = emailKey(evidence.lead.email);
    const email =
      person === originalPerson && leadEmailKey && usableKeys.includes(leadEmailKey)
        ? leadEmailKey
        : usableKeys.filter(isEmailKey).pop();
    const phone = usableKeys.filter(isPhoneKey).pop();
    return {
      email: email ? keyToIdentifier(email).value : undefined,
      fullName: meetings.flatMap((meeting) => (meeting.name ? [meeting.name] : [])).pop(),
      phone: phone ? keyToIdentifier(phone).value : undefined,
      customFieldsMeetingId: meetings.filter((meeting) => meeting.hasFormResponses).pop()?.meetingId,
    };
  };

  const targetChoices = overrides?.mergeTargets ?? [];
  for (const choice of targetChoices) {
    const chosen = persons.find((person) => person.candidateKeys.includes(choice.personKey));
    if (!chosen || chosen === originalPerson) {
      flags.add({ flag: "stale_override", personKeys: [choice.personKey] });
    }
  }
  const planned: PlannedPerson[] = [];
  for (const person of persons) {
    const isOriginal = person === originalPerson;
    let role: PlannedPerson["role"] = isOriginal ? "original" : "new";
    let targetLeadId: Id<"leads"> | undefined;
    let mergeCandidateLeadIds: Id<"leads">[] = [];
    if (!isOriginal) {
      const keys = [...person.keys].filter((key) => ownsKey(person, key)).sort();
      const { leadIds, inPlanLeadIds } = await options.lookupMergeTargets(keys);
      const choice = targetChoices.find((candidate) =>
        person.candidateKeys.includes(candidate.personKey),
      );
      if (choice?.targetLeadId && !leadIds.includes(choice.targetLeadId)) {
        flags.add({ flag: "stale_override", personKeys: [choice.personKey] });
      }
      const target = choice
        ? choice.targetLeadId && leadIds.includes(choice.targetLeadId)
          ? choice.targetLeadId
          : undefined
        : leadIds.length === 1
          ? leadIds[0]
          : undefined;
      if (target) {
        role = "merge_into";
        targetLeadId = target;
        if (inPlanLeadIds.includes(target)) {
          flags.add({ flag: "merge_target_in_plan", leadIds: [target], personKeys: [personKey(person)] });
        }
      } else if (!choice && leadIds.length > 1) {
        mergeCandidateLeadIds = leadIds;
        flags.add({ flag: "merge_target_ambiguous", leadIds, personKeys: [personKey(person)] });
      }
    }
    planned.push({
      personKey: personKey(person),
      candidateKeys: person.candidateKeys,
      role,
      targetLeadId,
      mergeCandidateLeadIds,
      meetingIds: person.meetingIds,
      identifierIds: person.identifierIds,
      slackEventIds: person.slackEventIds,
      opportunityPlan: person.opportunityPlan,
      canonical: canonicalFor(person),
    });
  }

  return {
    tier,
    persons: planned,
    ...flags.result(),
    placeholderIdentifierIds,
    unattributedMeetingIds: unattributed,
    slackFieldsPersonKey,
  };
}
