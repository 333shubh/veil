// Bytes on the wire, under a plain fixed-width binary encoding of each message as the implementation builds it.
import type { Confirm, MeterId, Release } from '../src/protocol.ts';
import type { RoundTrace } from '../src/simulation.ts';

export const BYTES = { id: 4, round: 4, u64: 8, hash: 32, signature: 64, tag: 16, share: 33, sealed: 33 + 16, key: 32 };

export const reportBytes = BYTES.id + BYTES.round + BYTES.u64 + BYTES.tag;
export const keysBytes = BYTES.id + 4 + 2 * BYTES.key + BYTES.signature;

/** An announced active or final set as a list of meter ids. */
export const setBytes = (size: number) => BYTES.round + BYTES.id * size;

export const confirmBytes = (c: Confirm) =>
  BYTES.id + BYTES.round + 2 * BYTES.hash + 2 * BYTES.u64 + BYTES.signature + c.tags.size * (BYTES.id + BYTES.tag) + c.shares.size * (BYTES.id + BYTES.sealed);

/** The part of a confirmation relayed to one neighbour: header, its tag and its sealed share. */
export const relayedBytes = (c: Confirm, to: MeterId) =>
  BYTES.id + BYTES.round + BYTES.hash + (c.tags.has(to) ? BYTES.tag : 0) + (c.shares.has(to) ? BYTES.sealed : 0);

export const releaseBytes = (r: Release) =>
  BYTES.id + BYTES.round + BYTES.hash + r.shares.size * (BYTES.id + BYTES.share) + (r.extra ? BYTES.u64 + BYTES.signature : 0);

export interface MeterBytes {
  sent: { report: number; confirm: number; release: number };
  received: { active: number; confirms: number; final: number };
}

/** Per-meter bytes in one round, for the meters that reported. */
export function perMeter(trace: RoundTrace): Map<MeterId, MeterBytes> {
  const out = new Map<MeterId, MeterBytes>();
  for (const r of trace.reports) out.set(r.id, { sent: { report: reportBytes, confirm: 0, release: 0 }, received: { active: 0, confirms: 0, final: 0 } });
  for (const [id, b] of out) {
    if (trace.active) b.received.active = setBytes(trace.active.size);
    if (trace.final?.has(id)) b.received.final = setBytes(trace.final.size);
    for (const c of trace.inbox?.get(id) ?? []) b.received.confirms += relayedBytes(c, id);
  }
  for (const c of trace.confirms) out.get(c.id)!.sent.confirm = confirmBytes(c);
  for (const r of trace.releases) out.get(r.id)!.sent.release = releaseBytes(r);
  return out;
}
