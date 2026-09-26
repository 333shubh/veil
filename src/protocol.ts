// Veil protocol core: a double-masked secure sum over a neighbour graph. Everything released to recover a round is
// specific to that round (self-mask values and pairwise masks, never the epoch seeds or keys behind them), and each
// meter releases at most one kind of recovery value per neighbour per round.
import { randomBytes } from 'node:crypto';
import {
  equal,
  hkdf,
  keystream,
  open,
  prg,
  seal,
  sha256,
  signBytes,
  tag,
  verifyBytes,
  x25519,
  x25519Keygen,
  type KeyPair,
  type SigningKey,
} from './crypto.ts';
import { harary } from './graph.ts';
import { add, decode, encode, sub, type U64 } from './ring.ts';
import { combine, SHARE_BYTES, split, toBigInt, toBytes, type Share } from './shamir.ts';

export type MeterId = number; // nonzero u32; doubles as the meter's Shamir evaluation point

export interface GroupParams {
  epoch: number; // u32
  threshold: number; // t: shares needed to rebuild a round's self-mask
  minGroupSize: number; // totals over fewer meters are never published
  graph: ReadonlyMap<MeterId, readonly MeterId[]>; // symmetric neighbour lists N(i)
}

/** Recorded on the ledger at epoch setup and signed by the operator; fixes the roster and the graph. */
export interface EpochAnchor {
  epoch: number;
  roster: readonly MeterId[];
  beacon: Uint8Array; // public randomness for the epoch; the graph seed is derived from it and the roster
  k: number;
  signature: Uint8Array;
}

export interface PublicKeys {
  id: MeterId;
  epoch: number;
  mask: Uint8Array; // X25519 key behind every k_ij
  channel: Uint8Array; // X25519 key behind share transport and neighbour confirmations
  signature: Uint8Array; // device signature, so the relay cannot substitute keys
}

export interface Report {
  id: MeterId;
  round: number;
  y: U64;
  tag: Uint8Array; // HMAC under the epoch's report key
}

/** Sent once the active set U is announced: the signed contribution, neighbour confirmations and dealt shares. */
export interface Confirm {
  id: MeterId;
  round: number;
  activeHash: Uint8Array;
  y: U64;
  correction: U64; // sum of s_ij m_ij(t) over neighbours outside U
  commitment: Uint8Array; // SHA-256 over this round's self-mask secret
  signature: Uint8Array; // device co-signature over the active set and this contribution
  tags: ReadonlyMap<MeterId, Uint8Array>; // per neighbour in U: MAC of the active-set hash under the pair key
  shares: ReadonlyMap<MeterId, Uint8Array>; // per neighbour in U: sealed Shamir share of the self-mask secret
}

export interface Release {
  id: MeterId;
  round: number;
  finalHash: Uint8Array;
  shares: ReadonlyMap<MeterId, bigint>; // neighbours' self-mask shares, for neighbours in F
  extra?: { value: U64; signature: Uint8Array }; // signed sum of s_ij m_ij(t) over neighbours in U \ F, if any
}

export interface Aborted {
  aborted: string;
}
export const isAborted = (x: object): x is Aborted => 'aborted' in x;

export interface Contribution {
  id: MeterId;
  y: U64;
  correction: U64;
  commitment: Uint8Array;
  signature: Uint8Array;
}

/** What an auditor needs to recompute a published total. */
export interface RoundEvidence {
  epoch: number;
  round: number;
  active: MeterId[];
  final: MeterId[];
  contributions: Contribution[];
  secrets: ReadonlyMap<MeterId, Uint8Array>; // rebuilt self-mask secrets of F
  extras: { id: MeterId; value: U64; signature: Uint8Array }[]; // signed releases for neighbours in U \ F
}

export type RoundResult =
  | { status: 'published'; total: bigint; evidence: RoundEvidence }
  | { status: 'suppressed' }
  | { status: 'aborted'; reason: string };

const label = (s: string) => Buffer.from(`veil/v1/${s}`);
const isU32 = (v: number) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff;

function u32s(values: Iterable<number>): Buffer {
  const list = [...values];
  const b = Buffer.alloc(4 * list.length);
  list.forEach((v, i) => b.writeUInt32BE(v, 4 * i));
  return b;
}

function le64(v: U64): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

const sortedIds = (ids: Iterable<MeterId>) => [...ids].sort((a, b) => a - b);

export const setHash = (kind: 'active' | 'final', epoch: number, round: number, ids: Iterable<MeterId>) =>
  sha256(label(kind), u32s([epoch, round]), u32s(sortedIds(ids)));

export const contributionHash = (epoch: number, round: number, c: Omit<Contribution, 'signature'>) =>
  sha256(label('contribution'), u32s([epoch, round, c.id]), le64(c.y), le64(c.correction), c.commitment);

export const cosignMessage = (epoch: number, round: number, activeHash: Uint8Array, contribution: Uint8Array) =>
  Buffer.concat([label('cosign'), u32s([epoch, round]), activeHash, contribution]);

export const releaseMessage = (epoch: number, round: number, id: MeterId, finalHash: Uint8Array, extra: U64) =>
  Buffer.concat([label('release'), u32s([epoch, round, id]), finalHash, le64(extra)]);

export const selfMaskCommitment = (epoch: number, round: number, id: MeterId, secret: Uint8Array) =>
  sha256(label('selfmask'), u32s([epoch, round, id]), secret);

const reportMessage = (epoch: number, round: number, id: MeterId, y: U64) => Buffer.concat([label('report'), u32s([epoch, round, id]), le64(y)]);
const keysMessage = (k: Omit<PublicKeys, 'signature'>) => Buffer.concat([label('keys'), u32s([k.epoch, k.id]), k.mask, k.channel]);
const confirmMessage = (epoch: number, round: number, activeHash: Uint8Array) => Buffer.concat([label('confirm'), u32s([epoch, round]), activeHash]);

export const anchorMessage = (a: Omit<EpochAnchor, 'signature'>) =>
  Buffer.concat([label('anchor'), u32s([a.epoch, a.k]), a.beacon, u32s(sortedIds(a.roster))]);

export function rosterHash(epoch: number, roster: readonly MeterId[], registry: ReadonlyMap<MeterId, Uint8Array>): Buffer {
  const entries = sortedIds(roster).map((id) => {
    const pk = registry.get(id);
    if (!pk) throw new RangeError(`meter ${id} has no device key`);
    return Buffer.concat([u32s([id]), pk]);
  });
  return sha256(label('roster'), u32s([epoch]), ...entries);
}

let graphCache: { key: string; graph: Map<MeterId, MeterId[]> } | undefined;

/** The epoch's graph: a random Harary graph whose seed hashes the roster with the public beacon. */
export function anchoredGraph(anchor: EpochAnchor, registry: ReadonlyMap<MeterId, Uint8Array>): Map<MeterId, MeterId[]> {
  const seed = sha256(label('graph'), rosterHash(anchor.epoch, anchor.roster, registry), anchor.beacon);
  const key = `${seed.toString('hex')}:${anchor.k}`;
  if (graphCache?.key !== key) graphCache = { key, graph: harary(anchor.roster, anchor.k, seed) };
  return graphCache.graph;
}

/** Build the epoch's parameters from its anchor. */
export function anchoredParams(anchor: EpochAnchor, registry: ReadonlyMap<MeterId, Uint8Array>, threshold: number, minGroupSize: number): GroupParams {
  return { epoch: anchor.epoch, threshold, minGroupSize, graph: anchoredGraph(anchor, registry) };
}

function checkParams(p: GroupParams, id: MeterId, neighbours: readonly MeterId[] | undefined): readonly MeterId[] {
  if (!isU32(p.epoch)) throw new RangeError(`epoch ${p.epoch} is not a u32`);
  if (!Number.isInteger(p.minGroupSize) || p.minGroupSize < 3) throw new RangeError('minimum group size must be at least 3');
  if (!neighbours) throw new RangeError(`meter ${id} is not in the roster`);
  if (id === 0 || !isU32(id)) throw new RangeError(`meter id ${id} is not a nonzero u32`);
  if (new Set(neighbours).size !== neighbours.length || neighbours.includes(id)) {
    throw new RangeError(`meter ${id} has repeated or self neighbours`);
  }
  if (!Number.isInteger(p.threshold) || p.threshold < 1 || p.threshold > neighbours.length) {
    throw new RangeError(`threshold ${p.threshold} does not fit degree ${neighbours.length} of meter ${id}`);
  }
  return neighbours;
}

/** A party accepts an epoch only if its parameters match the anchored roster and graph. */
function checkAnchor(p: GroupParams, anchor: EpochAnchor, registry: ReadonlyMap<MeterId, Uint8Array>, id?: MeterId): void {
  if (anchor.epoch !== p.epoch) throw new Error('parameters are for a different epoch than the anchor');
  const graph = anchoredGraph(anchor, registry);
  if (graph.size !== p.graph.size || anchor.roster.some((m) => !p.graph.has(m))) throw new Error('roster differs from the anchor');
  for (const m of id === undefined ? anchor.roster : [id]) {
    const want = graph.get(m)!;
    const got = sortedIds(p.graph.get(m)!);
    if (want.length !== got.length || got.some((v, i) => v !== want[i])) throw new Error(`neighbours of ${m} differ from the anchored graph`);
  }
}

/** HKDF-SHA256 over an X25519 secret, bound to the epoch and the unordered pair. */
function pairKey(kind: string, shared: Uint8Array, epoch: number, a: MeterId, b: MeterId): Uint8Array {
  return hkdf(shared, Buffer.concat([label(kind), u32s([epoch, Math.min(a, b), Math.max(a, b)])]));
}

/** One step of the report-key ratchet; the previous chain key is overwritten. */
function ratchet(chain: Uint8Array): Uint8Array {
  const next = hkdf(chain, label('ratchet'));
  chain.fill(0);
  return next;
}

const reportKey = (chain: Uint8Array, epoch: number) => hkdf(chain, Buffer.concat([label('report-key'), u32s([epoch])]));

interface PairKeys {
  mask: Uint8Array; // k_ij
  share: Uint8Array; // seals the round's self-mask shares
  confirm: Uint8Array; // MACs the active-set hash
}

interface RoundState {
  phase: 'reported' | 'confirmed' | 'done';
  y: U64;
  active?: ReadonlySet<MeterId>;
  activeHash?: Uint8Array;
  dealt?: boolean; // false: too few active neighbours, so this meter stays out of F but still passes on shares
  masksOut: Set<MeterId>; // neighbours whose round mask this meter has released
}

interface EpochState {
  params: GroupParams;
  neighbours: readonly MeterId[];
  maskKeys: KeyPair;
  channelKeys: KeyPair;
  seed: Buffer; // self-mask seed b_i: never leaves the meter
  reportKey: Uint8Array;
  pairs: Map<MeterId, PairKeys>;
  rounds: Map<number, RoundState>;
}

export class Meter {
  readonly id: MeterId;
  private readonly device: SigningKey;
  private readonly registry: ReadonlyMap<MeterId, Uint8Array>;
  private chain: Uint8Array;
  private epoch?: EpochState;

  constructor(id: MeterId, device: SigningKey, reportSecret: Uint8Array, registry: ReadonlyMap<MeterId, Uint8Array>) {
    this.id = id;
    this.device = device;
    this.registry = registry;
    this.chain = Uint8Array.from(reportSecret);
  }

  /** Epoch rollover: check the anchor, ratchet the report key, draw fresh epoch secrets and erase the old ones. */
  startEpoch(params: GroupParams, anchor: EpochAnchor): PublicKeys {
    const neighbours = checkParams(params, this.id, params.graph.get(this.id));
    checkAnchor(params, anchor, this.registry, this.id);
    this.erase();
    this.chain = ratchet(this.chain);
    this.epoch = {
      params,
      neighbours,
      maskKeys: x25519Keygen(),
      channelKeys: x25519Keygen(),
      seed: randomBytes(32),
      reportKey: reportKey(this.chain, params.epoch),
      pairs: new Map(),
      rounds: new Map(),
    };
    const keys = { id: this.id, epoch: params.epoch, mask: this.epoch.maskKeys.pk, channel: this.epoch.channelKeys.pk };
    return { ...keys, signature: signBytes(this.device, keysMessage(keys)) };
  }

  /** Derive the pair keys with every neighbour, after checking each neighbour's device signature. */
  keyExchange(directory: ReadonlyMap<MeterId, PublicKeys>): void {
    const e = this.current();
    const epoch = e.params.epoch;
    for (const j of e.neighbours) {
      const peer = directory.get(j);
      const device = this.registry.get(j);
      if (!peer || !device || peer.epoch !== epoch || !verifyBytes(device, keysMessage(peer), peer.signature)) {
        throw new Error(`no valid keys from neighbour ${j}`);
      }
      const channel = x25519(e.channelKeys, peer.channel);
      e.pairs.set(j, {
        mask: pairKey('mask', x25519(e.maskKeys, peer.mask), epoch, this.id, j),
        share: pairKey('share', channel, epoch, this.id, j),
        confirm: pairKey('confirm', channel, epoch, this.id, j),
      });
    }
  }

  /** y_i(t) = x_i(t) + PRG(b_i, t) + sum_{j in N(i)} s_ij PRG(k_ij, t)  (mod 2^64), s_ij = +1 iff id_i < id_j. */
  report(round: number, reading: bigint): Report {
    const e = this.current();
    if (!isU32(round)) throw new RangeError(`round ${round} is not a u32`);
    if (e.rounds.has(round)) throw new Error(`meter ${this.id} already reported round ${round}`);
    let y = add(encode(reading), prg(e.seed, e.params.epoch, round));
    for (const j of e.neighbours) y = this.signed(y, j, this.mask(j, round));
    e.rounds.set(round, { phase: 'reported', y, masksOut: new Set() });
    return { id: this.id, round, y, tag: tag(e.reportKey, reportMessage(e.params.epoch, round, this.id, y)) };
  }

  /**
   * On the announced active set U: release the round masks shared with neighbours outside U (as one correction),
   * deal t-of-n shares of this round's self-mask secret to neighbours in U, MAC the set's hash to each of them, and
   * co-sign the set with this meter's contribution. A meter with fewer than t neighbours in U cannot deal, so it stays
   * out of the total; it still confirms, releasing nothing of its own, and later passes on the shares it holds.
   */
  confirm(round: number, active: ReadonlySet<MeterId>): Confirm | Aborted {
    const e = this.current();
    const rs = e.rounds.get(round);
    if (!rs || rs.phase !== 'reported') return { aborted: 'not waiting for an active set' };
    const { epoch, threshold, minGroupSize } = e.params;
    const live = e.neighbours.filter((j) => active.has(j));
    const refusal = !active.has(this.id) ? 'left out of the active set' : active.size < minGroupSize ? 'active set below the minimum group size' : undefined;
    if (refusal) {
      rs.phase = 'done';
      return { aborted: refusal };
    }

    rs.dealt = live.length >= threshold;
    let correction: U64 = 0n;
    let commitment: Uint8Array = new Uint8Array(32);
    const shares = new Map<MeterId, Uint8Array>();
    if (rs.dealt) {
      for (const j of e.neighbours) {
        if (active.has(j)) continue;
        correction = this.signed(correction, j, this.mask(j, round));
        rs.masksOut.add(j);
      }
      const secret = keystream(e.seed, epoch, round, 32); // first 8 bytes are this round's self-mask
      commitment = selfMaskCommitment(epoch, round, this.id, secret);
      for (const s of split(secret, threshold, live.map(BigInt))) {
        const j = Number(s.x);
        shares.set(j, seal(e.pairs.get(j)!.share, u32s([this.id, j, round]), label('share'), toBytes(s.y, SHARE_BYTES)));
      }
    }
    const activeHash = setHash('active', epoch, round, active);
    const tags = new Map(live.map((j) => [j, tag(e.pairs.get(j)!.confirm, confirmMessage(epoch, round, activeHash))]));
    const contribution = { id: this.id, y: rs.y, correction, commitment };
    rs.phase = 'confirmed';
    rs.active = active;
    rs.activeHash = activeHash;
    return {
      ...contribution,
      round,
      activeHash,
      signature: signBytes(this.device, cosignMessage(epoch, round, activeHash, contributionHash(epoch, round, contribution))),
      tags,
      shares,
    };
  }

  /**
   * On the final set F (meters that dealt their shares): check that every neighbour confirmed the same U, then release
   * each F neighbour's self-mask share and, if this meter is in F, remove the round masks it shares with neighbours
   * in U \ F.
   */
  release(round: number, final: ReadonlySet<MeterId>, inbox: readonly Confirm[]): Release | Aborted {
    const e = this.current();
    const rs = e.rounds.get(round);
    if (!rs || rs.phase !== 'confirmed') return { aborted: 'not waiting to release' };
    rs.phase = 'done'; // one release per round, whatever happens next
    const { epoch, minGroupSize } = e.params;
    const active = rs.active!;
    if ([...final].some((i) => !active.has(i))) return { aborted: 'final set is not within the active set' };
    if (final.size < minGroupSize) return { aborted: 'final set below the minimum group size' };
    if (final.has(this.id) && !rs.dealt) return { aborted: 'final set includes this meter, which dealt no shares' };

    const held = new Map<MeterId, bigint>();
    const expected = confirmMessage(epoch, round, rs.activeHash!);
    for (const c of inbox) {
      const pair = e.pairs.get(c.id);
      const t = c.tags.get(this.id);
      if (!pair || c.round !== round) return { aborted: `unexpected confirmation from ${c.id}` };
      if (!equal(c.activeHash, rs.activeHash!) || !t || !equal(t, tag(pair.confirm, expected))) {
        return { aborted: `active set differs from neighbour ${c.id}'s` };
      }
      const sealed = c.shares.get(this.id);
      if (!sealed) continue;
      try {
        held.set(c.id, toBigInt(open(pair.share, u32s([c.id, this.id, round]), label('share'), sealed)));
      } catch {
        return { aborted: `share from ${c.id} failed authentication` };
      }
    }

    const shares = new Map<MeterId, bigint>();
    let extra: U64 | undefined;
    for (const j of e.neighbours) {
      if (!active.has(j)) continue; // its mask already went out in the correction
      if (final.has(j)) {
        if (rs.masksOut.has(j)) return { aborted: `already released the round mask shared with ${j}` };
        const s = held.get(j);
        if (s !== undefined) shares.set(j, s);
      } else if (final.has(this.id)) {
        extra = this.signed(extra ?? 0n, j, this.mask(j, round));
        rs.masksOut.add(j);
      }
    }
    const finalHash = setHash('final', epoch, round, final);
    const release: Release = { id: this.id, round, finalHash, shares };
    if (extra !== undefined) release.extra = { value: extra, signature: signBytes(this.device, releaseMessage(epoch, round, this.id, finalHash, extra)) };
    return release;
  }

  private current(): EpochState {
    if (!this.epoch) throw new Error(`meter ${this.id} has no epoch`);
    return this.epoch;
  }

  private mask(j: MeterId, round: number): U64 {
    const e = this.current();
    const pair = e.pairs.get(j);
    if (!pair) throw new Error(`meter ${this.id} has no key with ${j}`);
    return prg(pair.mask, e.params.epoch, round);
  }

  private signed(acc: U64, j: MeterId, mask: U64): U64 {
    return this.id < j ? add(acc, mask) : sub(acc, mask);
  }

  /** Overwrite the epoch's secrets; key objects are dropped with the state. */
  private erase(): void {
    const e = this.epoch;
    if (!e) return;
    for (const b of [e.seed, e.maskKeys.sk, e.channelKeys.sk, e.reportKey]) b.fill(0);
    for (const p of e.pairs.values()) for (const b of [p.mask, p.share, p.confirm]) b.fill(0);
    this.epoch = undefined;
  }
}

interface Pending {
  round: number;
  reports: Map<MeterId, U64>;
  active: ReadonlySet<MeterId>;
  confirms?: Map<MeterId, Confirm>;
  final?: ReadonlySet<MeterId>;
}

/** Untrusted relay and aggregator. Holds public keys and per-meter report keys, relays messages, and sums. */
export class Coordinator {
  private readonly registry: ReadonlyMap<MeterId, Uint8Array>;
  private readonly chains: Map<MeterId, Uint8Array>;
  private readonly reportKeys = new Map<MeterId, Uint8Array>();
  private readonly directory = new Map<MeterId, PublicKeys>();
  private params?: GroupParams;
  private pending?: Pending;

  constructor(reportSecrets: ReadonlyMap<MeterId, Uint8Array>, registry: ReadonlyMap<MeterId, Uint8Array>) {
    this.registry = registry;
    this.chains = new Map([...reportSecrets].map(([id, s]) => [id, Uint8Array.from(s)]));
  }

  startEpoch(params: GroupParams, anchor: EpochAnchor): void {
    for (const [i, ns] of params.graph) {
      checkParams(params, i, ns);
      for (const j of ns) if (!params.graph.get(j)?.includes(i)) throw new RangeError(`graph is not symmetric at ${i}-${j}`);
    }
    checkAnchor(params, anchor, this.registry);
    for (const id of params.graph.keys()) {
      const chain = this.chains.get(id);
      if (!chain) throw new Error(`no report secret for meter ${id}`);
      const next = ratchet(chain);
      this.chains.set(id, next);
      this.reportKeys.set(id, reportKey(next, params.epoch));
    }
    this.directory.clear();
    this.params = params;
    this.pending = undefined;
  }

  /** Collect each meter's signed epoch keys; the returned directory is broadcast to the group. */
  register(keys: readonly PublicKeys[]): ReadonlyMap<MeterId, PublicKeys> {
    const p = this.current();
    for (const k of keys) {
      const device = this.registry.get(k.id);
      if (!p.graph.has(k.id) || !device || k.epoch !== p.epoch || !verifyBytes(device, keysMessage(k), k.signature)) {
        throw new Error(`invalid keys from meter ${k.id}`);
      }
      this.directory.set(k.id, k);
    }
    return this.directory;
  }

  /** At the deadline: U is every meter with an authentic report for this round; other rounds' reports are dropped. */
  close(round: number, reports: readonly Report[]): { status: 'open'; active: ReadonlySet<MeterId> } | { status: 'suppressed' } {
    const p = this.current();
    const got = new Map<MeterId, U64>();
    for (const r of reports) {
      const key = this.reportKeys.get(r.id);
      if (r.round !== round || !key || got.has(r.id)) continue;
      if (equal(r.tag, tag(key, reportMessage(p.epoch, round, r.id, r.y)))) got.set(r.id, r.y);
    }
    const active = new Set(got.keys());
    this.pending = active.size >= p.minGroupSize ? { round, reports: got, active } : undefined;
    return this.pending ? { status: 'open', active } : { status: 'suppressed' };
  }

  /**
   * F is every meter in U whose valid confirmation deals at least t shares. Every valid confirmation is routed to the
   * sender's neighbours in U, and every confirmed meter is asked to release.
   */
  collect(
    confirms: readonly Confirm[],
  ): { status: 'open'; final: ReadonlySet<MeterId>; confirmed: ReadonlySet<MeterId>; inbox: Map<MeterId, Confirm[]> } | { status: 'suppressed' } {
    const p = this.current();
    const pending = this.pending;
    if (!pending) throw new Error('no active set');
    const activeHash = setHash('active', p.epoch, pending.round, pending.active);
    const valid = new Map<MeterId, Confirm>();
    for (const c of confirms) {
      const device = this.registry.get(c.id);
      if (!device || !pending.active.has(c.id) || c.round !== pending.round || valid.has(c.id)) continue;
      if (!equal(c.activeHash, activeHash) || c.y !== pending.reports.get(c.id)) continue;
      if (verifyBytes(device, cosignMessage(p.epoch, pending.round, activeHash, contributionHash(p.epoch, pending.round, c)), c.signature)) valid.set(c.id, c);
    }
    const final = new Set([...valid.values()].filter((c) => c.shares.size >= p.threshold).map((c) => c.id));
    if (final.size < p.minGroupSize) {
      this.pending = undefined;
      return { status: 'suppressed' };
    }
    const inbox = new Map<MeterId, Confirm[]>();
    for (const c of valid.values()) for (const j of p.graph.get(c.id)!) if (pending.active.has(j)) push(inbox, j, c);
    pending.confirms = valid;
    pending.final = final;
    return { status: 'open', final, confirmed: new Set(valid.keys()), inbox };
  }

  /**
   * sum_{i in F} x_i = sum_{i in F} (y_i - v_i(t) - c_i - e_i)   (mod 2^64)
   * v_i(t): the round's self-mask, rebuilt from t shares and checked against i's commitment; c_i: i's correction for
   * neighbours outside U; e_i: i's signed release for neighbours in U \ F (none if it has none). Masks between members
   * of F cancel.
   */
  recover(releases: readonly Release[]): RoundResult {
    const p = this.current();
    const pending = this.pending;
    if (!pending?.final || !pending.confirms) throw new Error('no final set');
    this.pending = undefined;
    const { epoch, threshold: t, graph } = p;
    const { round, active, final, confirms } = pending;
    const finalHash = setHash('final', epoch, round, final);

    const byId = new Map<MeterId, Release>();
    const seedShares = new Map<MeterId, Share[]>();
    for (const r of releases) {
      const device = this.registry.get(r.id);
      if (!confirms.has(r.id) || r.round !== round || byId.has(r.id) || !device || !equal(r.finalHash, finalHash)) continue;
      if (r.extra && !verifyBytes(device, releaseMessage(epoch, round, r.id, finalHash, r.extra.value), r.extra.signature)) continue;
      byId.set(r.id, r);
      for (const [i, y] of r.shares) if (final.has(i) && graph.get(i)!.includes(r.id)) push(seedShares, i, { x: BigInt(r.id), y });
    }

    const secrets = new Map<MeterId, Uint8Array>();
    let total: U64 = 0n;
    for (const i of sortedIds(final)) {
      const c = confirms.get(i)!;
      const shares = seedShares.get(i) ?? [];
      if (shares.length < t) return { status: 'aborted', reason: `self-mask of ${i}: ${shares.length}/${t} shares` };
      const secret = Buffer.from(combine(shares, t));
      if (!equal(selfMaskCommitment(epoch, round, i, secret), c.commitment)) {
        return { status: 'aborted', reason: `shares of ${i} do not match its commitment` };
      }
      secrets.set(i, secret);
      total = sub(sub(add(total, c.y), secret.readBigUInt64LE(0)), c.correction);
      if (graph.get(i)!.some((j) => active.has(j) && !final.has(j))) {
        const extra = byId.get(i)?.extra;
        if (!extra) return { status: 'aborted', reason: `meter ${i} did not remove its masks with meters that dropped after reporting` };
        total = sub(total, extra.value);
      }
    }
    return {
      status: 'published',
      total: decode(total),
      evidence: {
        epoch,
        round,
        active: sortedIds(active),
        final: sortedIds(final),
        contributions: sortedIds(confirms.keys()).map((i) => {
          const { id, y, correction, commitment, signature } = confirms.get(i)!;
          return { id, y, correction, commitment, signature };
        }),
        secrets,
        extras: [...byId.values()].flatMap(({ id, extra }) => (extra ? [{ id, ...extra }] : [])),
      },
    };
  }

  private current(): GroupParams {
    if (!this.params) throw new Error('coordinator has no epoch');
    return this.params;
  }
}
