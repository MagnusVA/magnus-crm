import type { Id } from "../_generated/dataModel";
import {
  isEmailKey,
  isPhoneKey,
  isSocialKey,
  namesCompatible,
  type IdentityKey,
} from "./identityKeys";

/** A meeting with the keys that say who booked it. */
export type KeyedMeeting = {
  meetingId: Id<"meetings">;
  scheduledAt: number;
  createdAt: number;
  keys: IdentityKey[];
  /** The invitee name from the Calendly snapshot. */
  name?: string;
};

export type Cluster = {
  /** In booking order. */
  meetingIds: Id<"meetings">[];
  keys: IdentityKey[];
  names: string[];
};

export type ClusterResult = {
  /** In order of each cluster's first meeting. */
  clusters: Cluster[];
  /** Meetings with no key at all. */
  unattributedMeetingIds: Id<"meetings">[];
};

export function compareMeetings(
  a: Pick<KeyedMeeting, "scheduledAt" | "createdAt" | "meetingId">,
  b: Pick<KeyedMeeting, "scheduledAt" | "createdAt" | "meetingId">,
): number {
  return (
    a.scheduledAt - b.scheduledAt ||
    a.createdAt - b.createdAt ||
    (a.meetingId < b.meetingId ? -1 : a.meetingId > b.meetingId ? 1 : 0)
  );
}

class UnionFind {
  private readonly parent: number[];
  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]];
      i = this.parent[i];
    }
    return i;
  }
  // The lower index stays the root, so roots follow booking order.
  union(a: number, b: number): void {
    const [rootA, rootB] = [this.find(a), this.find(b)];
    if (rootA !== rootB) this.parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB);
  }
}

function disjointWhenBothSet(a: IdentityKey[], b: IdentityKey[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const set = new Set(a);
  return !b.some((key) => set.has(key));
}

/**
 * Two groups of meetings that share an email are still two people when they
 * have different phones, different handles, or different invitee names. A
 * setter who books a second prospect with the first one's email looks like
 * this (§6.1, shared emails).
 */
export function clustersConflict(
  a: Pick<Cluster, "keys" | "names">,
  b: Pick<Cluster, "keys" | "names">,
): boolean {
  return (
    disjointWhenBothSet(a.keys.filter(isPhoneKey), b.keys.filter(isPhoneKey)) ||
    disjointWhenBothSet(a.keys.filter(isSocialKey), b.keys.filter(isSocialKey)) ||
    (a.names.length > 0 &&
      b.names.length > 0 &&
      !a.names.some((x) => b.names.some((y) => namesCompatible(x, y))))
  );
}

/**
 * Groups meetings into people (§4 rule 1). Phones and handles join meetings
 * outright; an email joins two groups only when they don't conflict, so a
 * reused email can't merge two people by itself.
 */
export function clusterMeetings(meetings: KeyedMeeting[]): ClusterResult {
  const sorted = [...meetings].sort(compareMeetings);
  const keyed = sorted.filter((meeting) => meeting.keys.length > 0);
  const unionFind = new UnionFind(keyed.length);

  const holders = new Map<IdentityKey, number[]>();
  keyed.forEach((meeting, index) => {
    for (const key of new Set(meeting.keys)) {
      holders.set(key, [...(holders.get(key) ?? []), index]);
    }
  });
  // Keys in order of first use, so an earlier booking's email joins first.
  const keyOrder = [...holders.keys()].sort(
    (a, b) => holders.get(a)![0] - holders.get(b)![0] || (a < b ? -1 : a > b ? 1 : 0),
  );

  for (const key of keyOrder) {
    if (isEmailKey(key)) continue;
    const [first, ...rest] = holders.get(key)!;
    for (const index of rest) unionFind.union(first, index);
  }

  const summarize = (root: number) => {
    const members = keyed.filter((_, index) => unionFind.find(index) === root);
    return {
      keys: [...new Set(members.flatMap((meeting) => meeting.keys))],
      names: members.flatMap((meeting) => (meeting.name ? [meeting.name] : [])),
    };
  };
  // Each later holder of an email joins the first earlier group it doesn't
  // conflict with.
  for (const key of keyOrder) {
    if (!isEmailKey(key)) continue;
    const list = holders.get(key)!;
    for (let i = 1; i < list.length; i += 1) {
      for (let j = 0; j < i; j += 1) {
        const [rootA, rootB] = [unionFind.find(list[j]), unionFind.find(list[i])];
        if (rootA === rootB) break;
        if (!clustersConflict(summarize(rootA), summarize(rootB))) {
          unionFind.union(rootA, rootB);
          break;
        }
      }
    }
  }

  const roots = [...new Set(keyed.map((_, index) => unionFind.find(index)))].sort(
    (a, b) => a - b,
  );
  const clusters = roots.map((root) => {
    const members = keyed.filter((_, index) => unionFind.find(index) === root);
    return {
      meetingIds: members.map((meeting) => meeting.meetingId),
      ...summarize(root),
    };
  });
  return {
    clusters,
    unattributedMeetingIds: sorted
      .filter((meeting) => meeting.keys.length === 0)
      .map((meeting) => meeting.meetingId),
  };
}

/** Email keys that more than one cluster holds, with those clusters' indexes. */
export function sharedEmailKeys(
  clusters: Pick<Cluster, "keys">[],
): { key: IdentityKey; clusters: number[] }[] {
  const holders = new Map<IdentityKey, number[]>();
  clusters.forEach((cluster, index) => {
    for (const key of new Set(cluster.keys)) {
      if (isEmailKey(key)) holders.set(key, [...(holders.get(key) ?? []), index]);
    }
  });
  return [...holders.entries()]
    .filter(([, owners]) => owners.length > 1)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, owners]) => ({ key, clusters: owners }));
}

/**
 * Pairs of clusters that share no key but whose invitee names agree. They
 * may be one person who changed phone and handle, so a reviewer decides.
 */
export function possibleSamePersonPairs(clusters: Cluster[]): [number, number][] {
  const pairs: [number, number][] = [];
  for (let i = 0; i < clusters.length; i += 1) {
    for (let j = i + 1; j < clusters.length; j += 1) {
      const keys = new Set(clusters[i].keys);
      const sharesKey = clusters[j].keys.some((key) => keys.has(key));
      const namesAgree = clusters[i].names.some((x) =>
        clusters[j].names.some((y) => namesCompatible(x, y)),
      );
      if (!sharesKey && namesAgree) pairs.push([i, j]);
    }
  }
  return pairs;
}

/**
 * A person's ID within a plan: their first meeting. It survives rebuilds that
 * add keys or later meetings, so reviewer overrides keep pointing at the same
 * person.
 */
export function personKeyOf(cluster: Pick<Cluster, "meetingIds">): string {
  const [first] = cluster.meetingIds;
  if (!first) throw new Error("A person needs at least one meeting");
  return `p_${first}`;
}

export function firstMeetingOfPersonKey(personKey: string): Id<"meetings"> {
  return personKey.slice("p_".length) as Id<"meetings">;
}
