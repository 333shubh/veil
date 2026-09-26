// Veil reference core: double-masked secure sum over a neighbour graph, with Shamir-based dropout recovery.
import { randomBytes } from 'node:crypto';
import { hkdf, open, prg, seal, x25519, x25519KeyPair, x25519Keygen, type KeyPair } from './crypto';
import { add, decode, encode, sub, type U64 } from './ring';
import { combine, SHARE_BYTES, split, toBigInt, toBytes, type Share } from './shamir';

export type MeterId = number; // nonzero u32; doubles as the meter's Shamir evaluation point

export interface GroupParams {
  epoch: number; // u32
  threshold: number; // t: shares needed to rebuild a seed or key
  minGroupSize: number; // totals over fewer active meters are never published
  graph: ReadonlyMap<MeterId, readonly MeterId[]>; // symmetric neighbour lists N(i)
}

export interface PublicKeys {
  id: MeterId;
  mask: Uint8Array; // X25519 key behind every k_ij; its private half is Shamir-shared
  channel: Uint8Array; // X25519 key for share transport; never shared, so a rebuilt mask key exposes no shares
}

export interface ShareEnvelope {
  from: MeterId;
  to: MeterId;
  sealed: Uint8Array; // AEAD(share of b_from || share of the mask key of from)
}

export interface Report {
  id: MeterId;
  round: number;
  y: U64;
}

export interface Release {
  from: MeterId;
  round: number;
  selfMask: ReadonlyMap<MeterId, bigint>; // shares of b_i, for neighbours in U_t
  maskKey: ReadonlyMap<MeterId, bigint>; // shares of the mask private key, for neighbours outside U_t
}

export type RoundResult =
  | { status: 'published'; total: bigint }
  | { status: 'suppressed' }
  | { status: 'aborted'; reason: string };

const isU32 = (v: number) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff;

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function u32s(...values: number[]): Buffer {
  const b = Buffer.alloc(4 * values.length);
  values.forEach((v, i) => b.writeUInt32BE(v, 4 * i));
  return b;
}

/** HKDF-SHA256 over an X25519 secret, bound to the epoch and the unordered pair. */
function pairKey(label: 'mask' | 'share', shared: Uint8Array, epoch: number, a: MeterId, b: MeterId): Uint8Array {
  return hkdf(shared, Buffer.concat([Buffer.from(`veil/v1/${label}`), u32s(epoch, Math.min(a, b), Math.max(a, b))]));
}

// One share envelope per direction per epoch, so (from, to) never repeats a nonce under a pair's key.
const envelopeNonce = (from: MeterId, to: MeterId) => u32s(from, to, 0);
const envelopeAad = (epoch: number, from: MeterId, to: MeterId) => u32s(epoch, from, to);

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

export class Meter {
  readonly neighbours: readonly MeterId[];
  private readonly maskKeys = x25519Keygen(); // ephemeral for the epoch
  private readonly channelKeys = x25519Keygen();
  private readonly seed = randomBytes(32); // self-mask seed b_i
  private readonly pairKeys = new Map<MeterId, Uint8Array>(); // k_ij
  private readonly transportKeys = new Map<MeterId, Uint8Array>();
  private readonly held = new Map<MeterId, { selfMask: bigint; maskKey: bigint }>();
  private readonly released = new Set<number>();

  constructor(
    readonly id: MeterId,
    private readonly params: GroupParams,
  ) {
    this.neighbours = checkParams(params, id, params.graph.get(id));
  }

  publicKeys(): PublicKeys {
    return { id: this.id, mask: this.maskKeys.pk, channel: this.channelKeys.pk };
  }

  /** Derive k_ij for each neighbour, then deal it one encrypted share of b_i and one of the mask key. */
  deal(directory: ReadonlyMap<MeterId, PublicKeys>): ShareEnvelope[] {
    const { epoch, threshold } = this.params;
    const points = this.neighbours.map(BigInt);
    const seedShares = split(this.seed, threshold, points);
    const keyShares = split(this.maskKeys.sk, threshold, points);
    return this.neighbours.map((j, n) => {
      const peer = directory.get(j);
      if (!peer) throw new Error(`no public keys for neighbour ${j}`);
      this.pairKeys.set(j, pairKey('mask', x25519(this.maskKeys, peer.mask), epoch, this.id, j));
      const transport = pairKey('share', x25519(this.channelKeys, peer.channel), epoch, this.id, j);
      this.transportKeys.set(j, transport);
      const body = Buffer.concat([toBytes(seedShares[n]!.y, SHARE_BYTES), toBytes(keyShares[n]!.y, SHARE_BYTES)]);
      return { from: this.id, to: j, sealed: seal(transport, envelopeNonce(this.id, j), envelopeAad(epoch, this.id, j), body) };
    });
  }

  accept(envelopes: readonly ShareEnvelope[]): void {
    for (const e of envelopes) {
      const transport = this.transportKeys.get(e.from);
      if (e.to !== this.id || !transport) throw new Error(`unexpected share envelope ${e.from} -> ${e.to}`);
      const body = open(transport, envelopeNonce(e.from, e.to), envelopeAad(this.params.epoch, e.from, e.to), e.sealed);
      this.held.set(e.from, { selfMask: toBigInt(body.subarray(0, SHARE_BYTES)), maskKey: toBigInt(body.subarray(SHARE_BYTES)) });
    }
  }

  /** y_i(t) = x_i(t) + PRG(b_i, t) + sum_{j in N(i)} s_ij PRG(k_ij, t)  (mod 2^64), s_ij = +1 iff id_i < id_j. */
  report(round: number, reading: bigint): Report {
    const { epoch } = this.params;
    let y = add(encode(reading), prg(this.seed, epoch, round));
    for (const j of this.neighbours) {
      const k = this.pairKeys.get(j);
      if (!k) throw new Error(`meter ${this.id} reported before setup`);
      const mask = prg(k, epoch, round);
      y = this.id < j ? add(y, mask) : sub(y, mask);
    }
    return { id: this.id, round, y };
  }

  /** One kind of share per neighbour: its self-mask seed if it is in U_t, its mask key if not. Once per round. */
  release(round: number, active: ReadonlySet<MeterId>): Release {
    if (this.released.has(round)) throw new Error(`meter ${this.id} already released shares for round ${round}`);
    this.released.add(round);
    const selfMask = new Map<MeterId, bigint>();
    const maskKey = new Map<MeterId, bigint>();
    for (const j of this.neighbours) {
      const held = this.held.get(j);
      if (!held) throw new Error(`meter ${this.id} holds no shares from ${j}`);
      if (active.has(j)) selfMask.set(j, held.selfMask);
      else maskKey.set(j, held.maskKey);
    }
    return { from: this.id, round, selfMask, maskKey };
  }
}

/** Untrusted relay and aggregator. Holds public keys, relays ciphertexts, and sums. */
export class Coordinator {
  private readonly directory = new Map<MeterId, PublicKeys>();
  private pending?: { round: number; reports: Map<MeterId, U64> };

  constructor(private readonly params: GroupParams) {
    for (const [i, ns] of params.graph) {
      checkParams(params, i, ns);
      for (const j of ns) if (!params.graph.get(j)?.includes(i)) throw new RangeError(`graph is not symmetric at ${i}-${j}`);
    }
  }

  /** Collect public keys; the returned directory is broadcast to the group. */
  register(keys: readonly PublicKeys[]): ReadonlyMap<MeterId, PublicKeys> {
    for (const k of keys) {
      if (!this.params.graph.has(k.id)) throw new Error(`meter ${k.id} is not in the roster`);
      this.directory.set(k.id, k);
    }
    return this.directory;
  }

  /** Relay share envelopes to their recipients. */
  route(envelopes: readonly ShareEnvelope[]): Map<MeterId, ShareEnvelope[]> {
    const inbox = new Map<MeterId, ShareEnvelope[]>();
    for (const e of envelopes) push(inbox, e.to, e);
    return inbox;
  }

  /** At the deadline, fix U_t from the reports in hand, or suppress the round. Reports for other rounds are dropped. */
  close(round: number, reports: readonly Report[]): { status: 'open'; active: ReadonlySet<MeterId> } | { status: 'suppressed' } {
    const got = new Map<MeterId, U64>();
    for (const r of reports) {
      if (r.round !== round) continue;
      if (!this.params.graph.has(r.id) || got.has(r.id)) throw new Error(`unexpected report from ${r.id}`);
      got.set(r.id, r.y);
    }
    this.pending = got.size >= this.params.minGroupSize ? { round, reports: got } : undefined;
    return this.pending ? { status: 'open', active: new Set(got.keys()) } : { status: 'suppressed' };
  }

  /**
   * sum_{i in U} x_i = sum_{i in U} y_i - sum_{i in U} PRG(b_i, t)
   *                  - sum_{i in U} sum_{d in N(i) \ U} s_id PRG(k_id, t)   (mod 2^64)
   */
  recover(releases: readonly Release[]): RoundResult {
    if (!this.pending) throw new Error('no open round');
    const { round, reports } = this.pending;
    this.pending = undefined;
    const { epoch, threshold: t, graph } = this.params;

    const seedShares = new Map<MeterId, Share[]>();
    const keyShares = new Map<MeterId, Share[]>();
    for (const r of releases) {
      if (r.round !== round) continue;
      for (const [i, y] of r.selfMask) if (reports.has(i)) push(seedShares, i, { x: BigInt(r.from), y });
      for (const [d, y] of r.maskKey) if (!reports.has(d)) push(keyShares, d, { x: BigInt(r.from), y });
    }

    const rebuiltKeys = new Map<MeterId, KeyPair>();
    let total: U64 = 0n;
    for (const [i, y] of reports) {
      const seed = seedShares.get(i) ?? [];
      if (seed.length < t) return { status: 'aborted', reason: `self-mask seed of ${i}: ${seed.length}/${t} shares` };
      total = sub(add(total, y), prg(combine(seed, t), epoch, round));
      for (const d of graph.get(i)!) {
        if (reports.has(d)) continue; // both reported: the pair's masks cancel on their own
        let sk = rebuiltKeys.get(d);
        if (!sk) {
          const shares = keyShares.get(d) ?? [];
          if (shares.length < t) return { status: 'aborted', reason: `mask key of ${d}: ${shares.length}/${t} shares` };
          sk = x25519KeyPair(combine(shares, t), this.directory.get(d)!.mask);
          rebuiltKeys.set(d, sk);
        }
        const mask = prg(pairKey('mask', x25519(sk, this.directory.get(i)!.mask), epoch, i, d), epoch, round);
        total = i < d ? sub(total, mask) : add(total, mask);
      }
    }
    return { status: 'published', total: decode(total) };
  }
}
