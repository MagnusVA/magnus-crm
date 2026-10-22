// What a read costs against Convex's per-call limits: documents, bytes and
// index ranges (a query or a get each read one range). The parity queries
// (convex/opportunities/stageParity.ts) pass one to the report readers to
// page under the limits and to show what the stage-way readers would read.
// The screens pass none.

export type ReadMeter = { docs: number; bytes: number; ranges: number };

export function newReadMeter(): ReadMeter {
  return { docs: 0, bytes: 0, ranges: 0 };
}

/**
 * Counts one document read. The bytes are its JSON length, close to the size
 * Convex counts against the 16 MiB a call may read.
 */
export function meterDocument(meter: ReadMeter | undefined, doc: object | null): void {
  if (!meter || doc === null) {
    return;
  }
  meter.docs += 1;
  meter.bytes += JSON.stringify(doc).length;
}

/** Counts one index range read: a query or a get. */
export function meterRange(meter: ReadMeter | undefined): void {
  if (meter) {
    meter.ranges += 1;
  }
}

export function addReadMeter(target: ReadMeter, source: ReadMeter): void {
  target.docs += source.docs;
  target.bytes += source.bytes;
  target.ranges += source.ranges;
}
