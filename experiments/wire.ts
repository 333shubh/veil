// Bytes on the wire, under a plain fixed-width binary encoding of each message as the implementation builds it.
import type { Check, Confirm, MeterId, Release, Unmask } from '../src/protocol.ts';
import type { RoundTrace } from '../src/simulation.ts';

export const BYTES = { id: 4, round: 4, u64: 8, hash: 32, signature: 64, tag: 16, share: 33, sealed: 33 + 16, key: 32, secret: 32 };

export const reportBytes = BYTES.id + BYTES.round + BYTES.u64 + BYTES.tag;
export const kemKeyBytes = 1184;
export const keysBytes = BYTES.id + 4 + 2 * BYTES.key + kemKeyBytes + BYTES.signature;
/** Setup message from the lower id of a pair: from, to, epoch, ML-KEM ciphertext, signature. */
export const encapsulationBytes = 3 * 4 + 1088 + BYTES.signature;

/** An announced set (U, F or an unmask request) as a bitmap over the anchored roster, which every meter holds. */
export const setBytes = (roster: number) => BYTES.round + Math.ceil(roster / 8);
/** The same set as a list of meter ids, as Phase 7 sent it. */
export const setListBytes = (size: number) => BYTES.round + BYTES.id * size;

export const confirmBytes = (c: Confirm) =>
  BYTES.id + BYTES.round + 2 * BYTES.hash + 2 * BYTES.u64 + BYTES.signature + c.tags.size * (BYTES.id + BYTES.tag) + c.shares.size * (BYTES.id + BYTES.sealed);

/** The part of a confirmation relayed to one neighbour: header, its tag and its sealed share. */
export const relayedConfirmBytes = (c: Confirm, to: MeterId) =>
  BYTES.id + BYTES.round + BYTES.hash + (c.tags.has(to) ? BYTES.tag : 0) + (c.shares.has(to) ? BYTES.sealed : 0);

/** A sealed removal: the 8-byte value and its signature, plus the AEAD tag. */
const escrowBytes = BYTES.u64 + BYTES.signature + 16;

export const checkBytes = (c: Check) =>
  BYTES.id + BYTES.round + BYTES.hash + c.agree.size * (BYTES.id + BYTES.tag) + (c.escrow ? escrowBytes + c.escrow.shares.size * (BYTES.id + BYTES.sealed) : 0);

/** The part of a check relayed to one neighbour in F: header, its agreement MAC and its sealed escrow-key share. */
export const relayedCheckBytes = (c: Check, to: MeterId) =>
  BYTES.id + BYTES.round + BYTES.hash + (c.agree.has(to) ? BYTES.tag : 0) + (c.escrow?.shares.has(to) ? BYTES.sealed : 0);

export const releaseBytes = (r: Release) => BYTES.id + BYTES.round + BYTES.hash + BYTES.secret + (r.removal ? BYTES.u64 + BYTES.signature : 0);

export const unmaskBytes = (u: Unmask) => BYTES.id + BYTES.round + BYTES.hash + (u.shares.size + u.keys.size) * (BYTES.id + BYTES.share);

export interface MeterBytes {
  sent: { report: number; confirm: number; check: number; release: number; unmask: number };
  received: { sets: number; confirms: number; checks: number };
}

/** Per-meter bytes in one round, for the meters that reported; `roster` sizes the set bitmaps. */
export function perMeter(trace: RoundTrace, roster: number): Map<MeterId, MeterBytes> {
  const out = new Map<MeterId, MeterBytes>();
  for (const r of trace.reports) {
    out.set(r.id, { sent: { report: reportBytes, confirm: 0, check: 0, release: 0, unmask: 0 }, received: { sets: 0, confirms: 0, checks: 0 } });
  }
  for (const [id, b] of out) {
    if (trace.active) b.received.sets += setBytes(roster);
    if (trace.inbox?.has(id) || trace.checks.some((c) => c.id === id)) b.received.sets += setBytes(roster); // F, with the confirmations
    if (trace.requests?.has(id)) b.received.sets += setBytes(roster);
    for (const c of trace.inbox?.get(id) ?? []) b.received.confirms += relayedConfirmBytes(c, id);
    for (const c of trace.routed?.get(id) ?? []) b.received.checks += relayedCheckBytes(c, id);
  }
  for (const c of trace.confirms) out.get(c.id)!.sent.confirm = confirmBytes(c);
  for (const c of trace.checks) out.get(c.id)!.sent.check = checkBytes(c);
  for (const r of trace.releases) out.get(r.id)!.sent.release = releaseBytes(r);
  for (const u of trace.unmasks) out.get(u.id)!.sent.unmask = unmaskBytes(u);
  return out;
}
