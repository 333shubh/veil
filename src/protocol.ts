// Veil protocol core: a double-masked secure sum over a neighbour graph. Everything released to recover a round is
// specific to that round (self-mask values and pairwise masks, never the epoch seeds or keys behind them), and each
// meter releases at most one kind of recovery value per neighbour per round.
//
// A round: report, then close (the coordinator fixes the active set U), confirm (each meter co-signs U, removes its
// masks with neighbours outside U and deals shares of its self-mask to neighbours in U), collect (the coordinator fixes
// the final set F of meters whose self-masks can be rebuilt), check (neighbours tell each other, under their pair keys,
// which U and F they were shown; a meter in F escrows the removal of its masks with neighbours in U \ F), release (a
// meter in F whose view at least t of its F neighbours share reveals its own self-mask and removal), and, only for
// meters in F that went silent, unmask (neighbours release self-mask shares and escrow-key shares) and recover.
// docs/rounds.md gives the security argument for the check.
import { randomBytes } from 'node:crypto';
import {
  equal,
  hkdf,
  kemDecapsulate,
  kemEncapsulate,
  kemKeygen,
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
  type KemKeyPair,
  type KeyPair,
  type SigningKey,
} from './crypto.ts';
import { harary } from './graph.ts';
import { add, decode, encode, sub, type U64 } from './ring.ts';
import { combine, SHARE_BYTES, split, toBigInt, toBytes, type Share } from './shamir.ts';

export type MeterId = number; // nonzero u32; doubles as the meter's Shamir evaluation point

export interface GroupParams {
  epoch: number; // u32
  threshold: number; // t: shares needed to rebuild a round's self-mask, and neighbours that must agree on F
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
  kem: Uint8Array; // ML-KEM-768 key; each pair key also depends on a secret encapsulated to it
  signature: Uint8Array; // device signature, so the relay cannot substitute keys
}

/** Sent at setup by the lower id of each pair: an ML-KEM secret encapsulated to the other, signed by the sender. */
export interface Encapsulation {
  from: MeterId;
  to: MeterId;
  epoch: number;
  ciphertext: Uint8Array;
  signature: Uint8Array;
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

/** The round masks a meter in F shares with its neighbours in U \ F, summed and signed. */
export interface Removal {
  id: MeterId;
  value: U64; // sum of s_ij m_ij(t) over neighbours in U \ F
  signature: Uint8Array;
}

/** Sent once F is announced: which U and F this meter was shown, told to each neighbour, and an escrowed removal. */
export interface Check {
  id: MeterId;
  round: number;
  finalHash: Uint8Array;
  agree: ReadonlyMap<MeterId, Uint8Array>; // per neighbour in U: MAC over (sender, receiver, U, F) under the pair key
  escrow?: {
    sealed: Uint8Array; // the signed removal under a one-round key
    shares: ReadonlyMap<MeterId, Uint8Array>; // per neighbour in F: sealed Shamir share of that key
  };
}

/** Sent by a meter in F once at least t of its F neighbours agree with its view: its own round secret and removal. */
export interface Release {
  id: MeterId;
  round: number;
  finalHash: Uint8Array;
  secret: Uint8Array; // this round's self-mask secret
  removal?: Removal;
}

/** Sent only when a meter in F went silent: its neighbours' shares of its self-mask secret and escrow key. */
export interface Unmask {
  id: MeterId;
  round: number;
  finalHash: Uint8Array;
  shares: ReadonlyMap<MeterId, bigint>; // self-mask shares of the requested neighbours
  keys: ReadonlyMap<MeterId, bigint>; // escrow-key shares of the requested neighbours that agreed with this meter
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
  secrets: ReadonlyMap<MeterId, Uint8Array>; // self-mask secrets of F, revealed or rebuilt
  removals: Removal[]; // signed removals of meters in F with neighbours in U \ F
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

export const removalMessage = (epoch: number, round: number, id: MeterId, finalHash: Uint8Array, value: U64) =>
  Buffer.concat([label('removal'), u32s([epoch, round, id]), finalHash, le64(value)]);

export const selfMaskCommitment = (epoch: number, round: number, id: MeterId, secret: Uint8Array) =>
  sha256(label('selfmask'), u32s([epoch, round, id]), secret);

const reportMessage = (epoch: number, round: number, id: MeterId, y: U64) => Buffer.concat([label('report'), u32s([epoch, round, id]), le64(y)]);
const keysMessage = (k: Omit<PublicKeys, 'signature'>) => Buffer.concat([label('keys'), u32s([k.epoch, k.id]), k.mask, k.channel, k.kem]);
const encapsulationMessage = (e: Omit<Encapsulation, 'signature'>) => Buffer.concat([label('kem'), u32s([e.epoch, e.from, e.to]), e.ciphertext]);
// Pair MACs name sender and receiver, so the relay cannot reflect a meter's own MAC back to it as its neighbour's.
const confirmMessage = (epoch: number, round: number, from: MeterId, to: MeterId, activeHash: Uint8Array) =>
  Buffer.concat([label('confirm'), u32s([epoch, round, from, to]), activeHash]);
const agreeMessage = (epoch: number, round: number, from: MeterId, to: MeterId, activeHash: Uint8Array, finalHash: Uint8Array) =>
  Buffer.concat([label('agree'), u32s([epoch, round, from, to]), activeHash, finalHash]);
const escrowAad = (epoch: number, round: number, id: MeterId) => Buffer.concat([label('escrow'), u32s([epoch, round, id])]);

/** Open an escrowed removal with its rebuilt key; throws if the key or the ciphertext is wrong. */
export function openEscrow(epoch: number, round: number, id: MeterId, key: Uint8Array, sealed: Uint8Array): Removal {
  const plain = open(key, u32s([epoch, round, id]), escrowAad(epoch, round, id), sealed);
  return { id, value: Buffer.from(plain).readBigUInt64LE(0), signature: Buffer.from(plain.subarray(8)) };
}

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

/** HKDF-SHA256 over the pair's X25519 and ML-KEM secrets, bound to the epoch and the unordered pair. */
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

/**
 * F is the meters that dealt their self-mask shares, less any with fewer than t neighbours in F (repeated until none
 * is left): a meter in F must hear agreement from t F neighbours before it releases anything that depends on F.
 */
export function finalSet(dealt: Iterable<MeterId>, graph: ReadonlyMap<MeterId, readonly MeterId[]>, t: number): Set<MeterId> {
  const final = new Set(dealt);
  for (let changed = true; changed; ) {
    changed = false;
    for (const i of final) {
      if (graph.get(i)!.filter((j) => final.has(j)).length < t) {
        final.delete(i);
        changed = true;
      }
    }
  }
  return final;
}

interface PairKeys {
  mask: Uint8Array; // k_ij
  share: Uint8Array; // seals the round's self-mask shares
  escrow: Uint8Array; // seals the round's escrow-key shares
  confirm: Uint8Array; // MACs the active-set and final-set hashes
}

interface RoundState {
  phase: 'reported' | 'confirmed' | 'checked' | 'released' | 'done';
  y: U64;
  active?: ReadonlySet<MeterId>;
  activeHash?: Uint8Array;
  dealt?: boolean; // false: too few active neighbours, so this meter stays out of F but still passes on shares
  final?: ReadonlySet<MeterId>; // the one F this meter accepts for the round
  finalHash?: Uint8Array;
  held: Map<MeterId, bigint>; // neighbours' self-mask shares
  escrowed: Map<MeterId, bigint>; // escrow-key shares of neighbours that agreed with this meter's view
  masksOut: Set<MeterId>; // neighbours whose round mask this meter has released
  removal?: Removal;
}

interface EpochState {
  params: GroupParams;
  neighbours: readonly MeterId[];
  maskKeys: KeyPair;
  channelKeys: KeyPair;
  kemKeys: KemKeyPair;
  peers: Map<MeterId, PublicKeys>; // neighbours' checked keys, kept until the pair keys are derived
  kemSecrets: Map<MeterId, Uint8Array>;
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
      kemKeys: kemKeygen(),
      peers: new Map(),
      kemSecrets: new Map(),
      seed: randomBytes(32),
      reportKey: reportKey(this.chain, params.epoch),
      pairs: new Map(),
      rounds: new Map(),
    };
    const keys = { id: this.id, epoch: params.epoch, mask: this.epoch.maskKeys.pk, channel: this.epoch.channelKeys.pk, kem: this.epoch.kemKeys.publicKey };
    return { ...keys, signature: signBytes(this.device, keysMessage(keys)) };
  }

  /**
   * Check each neighbour's device-signed keys, and encapsulate an ML-KEM secret to every neighbour with a higher id.
   * The pair keys are derived in finishKeys, once the lower-id neighbours' encapsulations arrive.
   */
  keyExchange(directory: ReadonlyMap<MeterId, PublicKeys>): Encapsulation[] {
    const e = this.current();
    const epoch = e.params.epoch;
    const out: Encapsulation[] = [];
    for (const j of e.neighbours) {
      const peer = directory.get(j);
      const device = this.registry.get(j);
      if (!peer || !device || peer.epoch !== epoch || !verifyBytes(device, keysMessage(peer), peer.signature)) {
        throw new Error(`no valid keys from neighbour ${j}`);
      }
      e.peers.set(j, peer);
      if (j < this.id) continue;
      const { ciphertext, secret } = kemEncapsulate(peer.kem);
      e.kemSecrets.set(j, secret);
      const body = { from: this.id, to: j, epoch, ciphertext };
      out.push({ ...body, signature: signBytes(this.device, encapsulationMessage(body)) });
    }
    return out;
  }

  /** Take the lower-id neighbours' signed encapsulations, then derive every pair key from X25519 and ML-KEM together. */
  finishKeys(inbox: readonly Encapsulation[]): void {
    const e = this.current();
    const epoch = e.params.epoch;
    for (const m of inbox) {
      const device = this.registry.get(m.from);
      if (m.to !== this.id || m.epoch !== epoch || m.from > this.id || !e.peers.has(m.from) || !device || !verifyBytes(device, encapsulationMessage(m), m.signature)) {
        throw new Error(`invalid encapsulation from ${m.from}`);
      }
      e.kemSecrets.set(m.from, kemDecapsulate(m.ciphertext, e.kemKeys.secretKey));
    }
    for (const j of e.neighbours) {
      const peer = e.peers.get(j);
      const kem = e.kemSecrets.get(j);
      if (!peer || !kem) throw new Error(`no key material with neighbour ${j}`);
      const channel = Buffer.concat([x25519(e.channelKeys, peer.channel), kem]);
      e.pairs.set(j, {
        mask: pairKey('mask', Buffer.concat([x25519(e.maskKeys, peer.mask), kem]), epoch, this.id, j),
        share: pairKey('share', channel, epoch, this.id, j),
        escrow: pairKey('escrow', channel, epoch, this.id, j),
        confirm: pairKey('confirm', channel, epoch, this.id, j),
      });
    }
    for (const b of e.kemSecrets.values()) b.fill(0);
    e.kemSecrets.clear();
    e.peers.clear();
  }

  /** y_i(t) = x_i(t) + PRG(b_i, t) + sum_{j in N(i)} s_ij PRG(k_ij, t)  (mod 2^64), s_ij = +1 iff id_i < id_j. */
  report(round: number, reading: bigint): Report {
    const e = this.current();
    if (!isU32(round)) throw new RangeError(`round ${round} is not a u32`);
    if (e.rounds.has(round)) throw new Error(`meter ${this.id} already reported round ${round}`);
    let y = add(encode(reading), prg(e.seed, e.params.epoch, round));
    for (const j of e.neighbours) y = this.signed(y, j, this.mask(j, round));
    e.rounds.set(round, { phase: 'reported', y, held: new Map(), escrowed: new Map(), masksOut: new Set() });
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
      const secret = this.secret(round);
      commitment = selfMaskCommitment(epoch, round, this.id, secret);
      for (const s of split(secret, threshold, live.map(BigInt))) {
        const j = Number(s.x);
        shares.set(j, seal(e.pairs.get(j)!.share, u32s([this.id, j, round]), label('share'), toBytes(s.y, SHARE_BYTES)));
      }
    }
    const activeHash = setHash('active', epoch, round, active);
    const tags = new Map(live.map((j) => [j, tag(e.pairs.get(j)!.confirm, confirmMessage(epoch, round, this.id, j, activeHash))]));
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
   * On the announced final set F, with the neighbours' confirmations: check that every neighbour confirmed the same U
   * and keep the self-mask shares they dealt, then fix F as this meter's only view of the round. A meter in F tells
   * each neighbour in U, under their pair key, which U and F it was shown; if it has neighbours in U \ F, it signs the
   * removal of the masks it shares with them and escrows it: sealed under a fresh key whose t-of-n shares go to its
   * F neighbours, who pass them on only if they were shown the same F.
   */
  check(round: number, final: ReadonlySet<MeterId>, inbox: readonly Confirm[]): Check | Aborted {
    const e = this.current();
    const rs = e.rounds.get(round);
    if (!rs || rs.phase !== 'confirmed') return { aborted: 'not waiting for a final set' };
    rs.phase = 'done'; // until the checks below pass
    const { epoch, threshold, minGroupSize } = e.params;
    const active = rs.active!;
    if ([...final].some((i) => !active.has(i))) return { aborted: 'final set is not within the active set' };
    if (final.size < minGroupSize) return { aborted: 'final set below the minimum group size' };
    const inFinal = final.has(this.id);
    if (inFinal && !rs.dealt) return { aborted: 'final set includes this meter, which dealt no shares' };

    for (const c of inbox) {
      const pair = e.pairs.get(c.id);
      const t = c.tags.get(this.id);
      if (!pair || c.round !== round) return { aborted: `unexpected confirmation from ${c.id}` };
      if (!equal(c.activeHash, rs.activeHash!) || !t || !equal(t, tag(pair.confirm, confirmMessage(epoch, round, c.id, this.id, rs.activeHash!)))) {
        return { aborted: `active set differs from neighbour ${c.id}'s` };
      }
      const sealed = c.shares.get(this.id);
      if (!sealed) continue;
      try {
        rs.held.set(c.id, toBigInt(open(pair.share, u32s([c.id, this.id, round]), label('share'), sealed)));
      } catch {
        return { aborted: `share from ${c.id} failed authentication` };
      }
    }

    const finalHash = setHash('final', epoch, round, final);
    const partners = e.neighbours.filter((j) => final.has(j));
    if (inFinal && partners.length < threshold) return { aborted: `only ${partners.length} neighbours in the final set, need ${threshold}` };
    rs.final = final;
    rs.finalHash = finalHash;
    rs.phase = 'checked';
    const check: Check = { id: this.id, round, finalHash, agree: new Map() };
    if (!inFinal) return check;

    check.agree = new Map(
      e.neighbours.filter((j) => active.has(j)).map((j) => [j, tag(e.pairs.get(j)!.confirm, agreeMessage(epoch, round, this.id, j, rs.activeHash!, finalHash))]),
    );
    const covered = e.neighbours.filter((j) => active.has(j) && !final.has(j));
    if (covered.length > 0) {
      let value: U64 = 0n;
      for (const j of covered) {
        value = this.signed(value, j, this.mask(j, round));
        rs.masksOut.add(j);
      }
      rs.removal = { id: this.id, value, signature: signBytes(this.device, removalMessage(epoch, round, this.id, finalHash, value)) };
      const key = randomBytes(32);
      const shares = new Map<MeterId, Uint8Array>();
      for (const s of split(key, threshold, partners.map(BigInt))) {
        const j = Number(s.x);
        shares.set(j, seal(e.pairs.get(j)!.escrow, u32s([this.id, j, round]), label('escrow-share'), toBytes(s.y, SHARE_BYTES)));
      }
      check.escrow = { sealed: seal(key, u32s([epoch, round, this.id]), escrowAad(epoch, round, this.id), Buffer.concat([le64(value), rs.removal.signature])), shares };
      key.fill(0);
    }
    return check;
  }

  /**
   * With the F neighbours' checks: if at least t of them were shown the same U and F as this meter, reveal this round's
   * self-mask secret and removal, and keep the escrow-key shares of the neighbours that agree. Those t neighbours never
   * remove the masks they share with this meter, so revealing the self-mask exposes nothing that their shares would not.
   */
  release(round: number, inbox: readonly Check[]): Release | Aborted {
    const e = this.current();
    const rs = e.rounds.get(round);
    if (!rs || rs.phase !== 'checked' || !rs.final!.has(this.id)) return { aborted: 'not waiting to release' };
    rs.phase = 'done'; // until agreement is shown
    const { epoch, threshold } = e.params;
    const agreeing = new Set<MeterId>();
    for (const c of inbox) {
      const pair = e.pairs.get(c.id);
      if (!pair || c.round !== round) return { aborted: `unexpected check from ${c.id}` };
      if (!rs.final!.has(c.id)) continue;
      const mac = c.agree.get(this.id);
      if (!equal(c.finalHash, rs.finalHash!) || !mac || !equal(mac, tag(pair.confirm, agreeMessage(epoch, round, c.id, this.id, rs.activeHash!, rs.finalHash!)))) {
        return { aborted: `final set differs from neighbour ${c.id}'s` };
      }
      agreeing.add(c.id);
      const sealed = c.escrow?.shares.get(this.id);
      if (!sealed) continue;
      try {
        rs.escrowed.set(c.id, toBigInt(open(pair.escrow, u32s([c.id, this.id, round]), label('escrow-share'), sealed)));
      } catch {
        return { aborted: `escrow share from ${c.id} failed authentication` };
      }
    }
    if (agreeing.size < threshold) return { aborted: `only ${agreeing.size} neighbours agree on the final set, need ${threshold}` };
    rs.phase = 'released';
    const release: Release = { id: this.id, round, finalHash: rs.finalHash!, secret: this.secret(round) };
    if (rs.removal) release.removal = rs.removal;
    return release;
  }

  /**
   * For requested neighbours in this meter's F: pass on their self-mask shares, and the escrow-key shares of those that
   * agreed with this meter's view. Never for a neighbour whose round mask this meter released.
   */
  unmask(round: number, want: ReadonlySet<MeterId>): Unmask | Aborted {
    const e = this.current();
    const rs = e.rounds.get(round);
    if (!rs || !(rs.phase === 'released' || (rs.phase === 'checked' && !rs.final!.has(this.id)))) return { aborted: 'not waiting to unmask' };
    rs.phase = 'done';
    const shares = new Map<MeterId, bigint>();
    const keys = new Map<MeterId, bigint>();
    for (const j of e.neighbours) {
      if (!want.has(j) || !rs.final!.has(j)) continue;
      if (rs.masksOut.has(j)) return { aborted: `already released the round mask shared with ${j}` };
      const s = rs.held.get(j);
      if (s !== undefined) shares.set(j, s);
      const k = rs.escrowed.get(j);
      if (k !== undefined) keys.set(j, k);
    }
    return { id: this.id, round, finalHash: rs.finalHash!, shares, keys };
  }

  private current(): EpochState {
    if (!this.epoch) throw new Error(`meter ${this.id} has no epoch`);
    return this.epoch;
  }

  /** The round's self-mask secret; its first 8 bytes are the self-mask. */
  private secret(round: number): Buffer {
    const e = this.current();
    return keystream(e.seed, e.params.epoch, round, 32);
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
    for (const b of [e.seed, e.maskKeys.sk, e.channelKeys.sk, e.kemKeys.secretKey, e.reportKey, ...e.kemSecrets.values()]) b.fill(0);
    for (const p of e.pairs.values()) for (const b of [p.mask, p.share, p.escrow, p.confirm]) b.fill(0);
    this.epoch = undefined;
  }
}

interface Pending {
  round: number;
  reports: Map<MeterId, U64>;
  active: ReadonlySet<MeterId>;
  confirms?: Map<MeterId, Confirm>;
  final?: ReadonlySet<MeterId>;
  escrows?: Map<MeterId, Uint8Array>; // sealed removals, by meter
  secrets?: Map<MeterId, Uint8Array>;
  removals?: Map<MeterId, Removal>;
  missing?: { secrets: Set<MeterId>; removals: Set<MeterId> };
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

  /** Relay setup encapsulations to their recipients. */
  relay(encapsulations: readonly Encapsulation[]): Map<MeterId, Encapsulation[]> {
    const inbox = new Map<MeterId, Encapsulation[]>();
    for (const m of encapsulations) push(inbox, m.to, m);
    return inbox;
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
   * F is finalSet() over the meters in U whose valid confirmation deals at least t shares. Every valid confirmation is
   * routed to the sender's neighbours in U, and every confirmed meter is asked to check.
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
    const dealt = [...valid.values()].filter((c) => c.shares.size >= p.threshold).map((c) => c.id);
    const final = finalSet(dealt, p.graph, p.threshold);
    if (final.size < p.minGroupSize) {
      this.pending = undefined;
      return { status: 'suppressed' };
    }
    const inbox = new Map<MeterId, Confirm[]>();
    for (const c of valid.values()) for (const j of p.graph.get(c.id)!) if (valid.has(j)) push(inbox, j, c);
    pending.confirms = valid;
    pending.final = final;
    return { status: 'open', final, confirmed: new Set(valid.keys()), inbox };
  }

  /** Keep each escrowed removal and route every check to the sender's neighbours in F, who are asked to release. */
  route(checks: readonly Check[]): Map<MeterId, Check[]> {
    const p = this.current();
    const pending = this.pending;
    if (!pending?.final || !pending.confirms) throw new Error('no final set');
    const finalHash = setHash('final', p.epoch, pending.round, pending.final);
    const escrows = new Map<MeterId, Uint8Array>();
    const inbox = new Map<MeterId, Check[]>();
    const seen = new Set<MeterId>();
    for (const c of checks) {
      if (!pending.confirms.has(c.id) || c.round !== pending.round || seen.has(c.id) || !equal(c.finalHash, finalHash)) continue;
      seen.add(c.id);
      if (c.escrow && pending.final.has(c.id)) escrows.set(c.id, c.escrow.sealed);
      for (const j of p.graph.get(c.id)!) if (pending.final.has(j)) push(inbox, j, c);
    }
    pending.escrows = escrows;
    return inbox;
  }

  /**
   * Take the releases. A meter in F that revealed a secret matching its commitment, and a signed removal if it has
   * neighbours in U \ F, needs nothing more; for the others, returns which neighbours to ask for shares.
   */
  gather(releases: readonly Release[]): { status: 'complete' } | { status: 'unmask'; requests: Map<MeterId, Set<MeterId>> } | { status: 'aborted'; reason: string } {
    const p = this.current();
    const pending = this.pending;
    if (!pending?.final || !pending.confirms || !pending.escrows) throw new Error('no routed checks');
    const { round, active, final, confirms, escrows } = pending;
    const finalHash = setHash('final', p.epoch, round, final);
    const needsRemoval = (i: MeterId) => p.graph.get(i)!.some((j) => active.has(j) && !final.has(j));
    const secrets = new Map<MeterId, Uint8Array>();
    const removals = new Map<MeterId, Removal>();
    for (const r of releases) {
      const device = this.registry.get(r.id);
      if (!final.has(r.id) || r.round !== round || secrets.has(r.id) || !device || !equal(r.finalHash, finalHash)) continue;
      if (!equal(selfMaskCommitment(p.epoch, round, r.id, r.secret), confirms.get(r.id)!.commitment)) continue;
      secrets.set(r.id, r.secret);
      const removal = r.removal;
      if (removal && needsRemoval(r.id) && removal.id === r.id && verifyBytes(device, removalMessage(p.epoch, round, r.id, finalHash, removal.value), removal.signature)) {
        removals.set(r.id, removal);
      }
    }
    const missing = { secrets: new Set<MeterId>(), removals: new Set<MeterId>() };
    for (const i of final) {
      if (!secrets.has(i)) missing.secrets.add(i);
      if (needsRemoval(i) && !removals.has(i)) {
        if (!escrows.has(i)) {
          this.pending = undefined;
          return { status: 'aborted', reason: `meter ${i} left no removal of its masks with meters that dropped after reporting` };
        }
        missing.removals.add(i);
      }
    }
    Object.assign(pending, { secrets, removals, missing });
    if (missing.secrets.size === 0 && missing.removals.size === 0) return { status: 'complete' };
    const requests = new Map<MeterId, Set<MeterId>>();
    for (const i of new Set([...missing.secrets, ...missing.removals])) {
      for (const j of p.graph.get(i)!) {
        if (!confirms.has(j)) continue;
        if (!requests.has(j)) requests.set(j, new Set());
        requests.get(j)!.add(i);
      }
    }
    return { status: 'unmask', requests };
  }

  /**
   * sum_{i in F} x_i = sum_{i in F} (y_i - v_i(t) - c_i - e_i)   (mod 2^64)
   * v_i(t): the round's self-mask, revealed by i or rebuilt from t shares, checked against i's commitment; c_i: i's
   * correction for neighbours outside U; e_i: i's signed removal for neighbours in U \ F, revealed by i or opened with
   * its escrow key rebuilt from t shares (none if it has none). Masks between members of F cancel.
   */
  recover(unmasks: readonly Unmask[] = []): RoundResult {
    const p = this.current();
    const pending = this.pending;
    if (!pending?.secrets || !pending.removals || !pending.missing) throw new Error('no gathered releases');
    this.pending = undefined;
    const { epoch, threshold: t, graph } = p;
    const { round, active, final, confirms, escrows, secrets, removals, missing } = pending;
    const finalHash = setHash('final', epoch, round, final!);

    const seedShares = new Map<MeterId, Share[]>();
    const keyShares = new Map<MeterId, Share[]>();
    const seen = new Set<MeterId>();
    for (const u of unmasks) {
      if (!confirms!.has(u.id) || u.round !== round || seen.has(u.id) || !equal(u.finalHash, finalHash)) continue;
      seen.add(u.id);
      for (const [i, y] of u.shares) if (missing.secrets.has(i) && graph.get(i)!.includes(u.id)) push(seedShares, i, { x: BigInt(u.id), y });
      for (const [i, y] of u.keys) if (missing.removals.has(i) && graph.get(i)!.includes(u.id)) push(keyShares, i, { x: BigInt(u.id), y });
    }
    for (const i of sortedIds(missing.secrets)) {
      const shares = seedShares.get(i) ?? [];
      if (shares.length < t) return { status: 'aborted', reason: `self-mask of ${i}: ${shares.length}/${t} shares` };
      const secret = Buffer.from(combine(shares, t));
      if (!equal(selfMaskCommitment(epoch, round, i, secret), confirms!.get(i)!.commitment)) {
        return { status: 'aborted', reason: `shares of ${i} do not match its commitment` };
      }
      secrets.set(i, secret);
    }
    for (const i of sortedIds(missing.removals)) {
      const shares = keyShares.get(i) ?? [];
      if (shares.length < t) return { status: 'aborted', reason: `escrowed removal of ${i}: ${shares.length}/${t} key shares` };
      try {
        const removal = openEscrow(epoch, round, i, combine(shares, t), escrows!.get(i)!);
        if (!verifyBytes(this.registry.get(i)!, removalMessage(epoch, round, i, finalHash, removal.value), removal.signature)) throw new Error();
        removals.set(i, removal);
      } catch {
        return { status: 'aborted', reason: `escrowed removal of ${i} does not open to a signed removal` };
      }
    }

    let total: U64 = 0n;
    for (const i of sortedIds(final!)) {
      const c = confirms!.get(i)!;
      total = sub(sub(add(total, c.y), Buffer.from(secrets.get(i)!).readBigUInt64LE(0)), c.correction);
      const removal = removals.get(i);
      if (removal) total = sub(total, removal.value);
    }
    return {
      status: 'published',
      total: decode(total),
      evidence: {
        epoch,
        round,
        active: sortedIds(active),
        final: sortedIds(final!),
        contributions: sortedIds(confirms!.keys()).map((i) => {
          const { id, y, correction, commitment, signature } = confirms!.get(i)!;
          return { id, y, correction, commitment, signature };
        }),
        secrets,
        removals: sortedIds(removals.keys()).map((i) => removals.get(i)!),
      },
    };
  }

  private current(): GroupParams {
    if (!this.params) throw new Error('coordinator has no epoch');
    return this.params;
  }
}
