// Audit layer: a minimal permissioned ledger that stores commitments only (roster hash, graph beacon, co-signed
// active-set hash, a Merkle root of the round's signed contributions, and the published total), plus the auditor's
// recomputation of a total from off-ledger evidence. In verified mode the record also carries each contributor's
// Pedersen commitment and the total's blinding, so validators check the total's arithmetic themselves.
import { equal, sha256, signBytes, verifyBytes, type SigningKey } from './crypto.ts';
import { mod as modL, sumsTo, verify as verifyRange } from './pedersen.ts';
import {
  anchorMessage,
  contributionFromDigest,
  contributionHash,
  cosignMessage,
  maskedDigest,
  proofContext,
  removalMessage,
  rosterHash,
  selfBlinding,
  selfMaskCommitment,
  setHash,
  type EpochAnchor,
  type MeterId,
  type RoundEvidence,
} from './protocol.ts';
import { add, decode, sub, type U64 } from './ring.ts';

export interface Cosigner {
  id: MeterId;
  contribution: Uint8Array; // hash of the meter's signed contribution (a leaf of the Merkle tree)
  signature: Uint8Array; // the meter's co-signature over the active set and that hash
  index: number;
  proof: Uint8Array[];
  // Verified mode: the commitment inside the contribution, the hash of the rest of it, and whether it is in the total.
  pedersen?: Uint8Array;
  digest?: Uint8Array;
  inTotal?: boolean;
}

export interface RoundRecord {
  epoch: number;
  round: number;
  activeHash: Uint8Array;
  contributionsRoot: Uint8Array;
  leaves: number;
  total: bigint;
  blinding?: bigint; // verified mode: sum of the commitments in the total = total G + blinding H
  cosigners: Cosigner[];
  signature: Uint8Array; // operator
}

export interface LedgerOptions {
  /** Verified mode: validators also check the range proof behind every commitment in a total. */
  checkProofs?: boolean;
}

const ONE = Buffer.from([1]);
const leaf = (id: MeterId, contribution: Uint8Array) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(id);
  return sha256(Buffer.from([0]), b, contribution);
};

function up(level: Buffer[]): Buffer[] {
  const next: Buffer[] = [];
  for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? sha256(ONE, level[i]!, level[i + 1]!) : level[i]!);
  return next;
}

export function merkleRoot(leaves: Buffer[]): Buffer {
  let level = leaves;
  if (level.length === 0) return sha256();
  while (level.length > 1) level = up(level);
  return level[0]!;
}

export function merkleProof(leaves: Buffer[], index: number): Buffer[] {
  const proof: Buffer[] = [];
  let level = leaves;
  for (let i = index; level.length > 1; i >>= 1) {
    if ((i ^ 1) < level.length) proof.push(level[i ^ 1]!);
    level = up(level);
  }
  return proof;
}

export function verifyMerkle(node: Uint8Array, index: number, count: number, proof: readonly Uint8Array[], root: Uint8Array): boolean {
  let at = 0;
  let hash: Buffer = Buffer.from(node);
  for (let i = index, n = count; n > 1; i >>= 1, n = Math.ceil(n / 2)) {
    if ((i ^ 1) >= n) continue;
    const sibling = proof[at++];
    if (!sibling) return false;
    hash = i % 2 === 0 ? sha256(ONE, hash, sibling) : sha256(ONE, sibling, hash);
  }
  return at === proof.length && equal(hash, root);
}

function body(r: Omit<RoundRecord, 'signature'>): Buffer {
  const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
  return Buffer.from(
    JSON.stringify({
      epoch: r.epoch,
      round: r.round,
      activeHash: hex(r.activeHash),
      contributionsRoot: hex(r.contributionsRoot),
      leaves: r.leaves,
      total: r.total.toString(),
      ...(r.blinding === undefined ? {} : { blinding: r.blinding.toString() }),
      cosigners: r.cosigners.map((c) => [
        c.id,
        hex(c.contribution),
        hex(c.signature),
        c.index,
        c.proof.map(hex),
        ...(c.pedersen ? [hex(c.pedersen), hex(c.digest!), Boolean(c.inTotal)] : []),
      ]),
    }),
  );
}

export function signAnchor(operator: SigningKey, a: Omit<EpochAnchor, 'signature'>): EpochAnchor {
  return { ...a, signature: signBytes(operator, anchorMessage(a)) };
}

/** The operator's round record: every co-signature on the active set, and a Merkle root of the contributions. */
export function recordFor(operator: SigningKey, evidence: RoundEvidence, total: bigint): RoundRecord {
  const { epoch, round } = evidence;
  const hashes = evidence.contributions.map((c) => contributionHash(epoch, round, c));
  const leaves = evidence.contributions.map((c, i) => leaf(c.id, hashes[i]!));
  const final = new Set(evidence.final);
  const unsigned: Omit<RoundRecord, 'signature'> = {
    epoch,
    round,
    activeHash: setHash('active', epoch, round, evidence.active),
    contributionsRoot: merkleRoot(leaves),
    leaves: leaves.length,
    total,
    cosigners: evidence.contributions.map((c, i) => {
      const cosigner: Cosigner = { id: c.id, contribution: hashes[i]!, signature: c.signature, index: i, proof: merkleProof(leaves, i) };
      if (c.pedersen) Object.assign(cosigner, { pedersen: c.pedersen, digest: maskedDigest(c), inTotal: final.has(c.id) });
      return cosigner;
    }),
  };
  if (evidence.blinding !== undefined) unsigned.blinding = evidence.blinding;
  return { ...unsigned, signature: signBytes(operator, body(unsigned)) };
}

export interface Entry {
  body: Buffer;
  hash: Buffer; // SHA-256 over the previous entry's hash and this body
}

/**
 * Validators accept an epoch anchor once per epoch, and a round record only if the operator signed it, a majority of
 * the roster co-signed the same active set with contributions proven under the record's Merkle root, and the round
 * has no total yet. In verified mode they also check that the total is the sum of the co-signed commitments marked as
 * in it, and optionally each commitment's range proof. Entries are hash-chained, so a rewritten past entry breaks the
 * chain.
 */
export class Ledger {
  private readonly operator: Uint8Array;
  private readonly registry: ReadonlyMap<MeterId, Uint8Array>;
  private readonly checkProofs: boolean;
  private readonly entries: Entry[] = [];
  private readonly anchors = new Map<number, EpochAnchor>();
  private readonly totals = new Map<string, bigint>();

  constructor(operator: Uint8Array, registry: ReadonlyMap<MeterId, Uint8Array>, options: LedgerOptions = {}) {
    this.operator = operator;
    this.registry = registry;
    this.checkProofs = options.checkProofs ?? false;
  }

  anchor(a: EpochAnchor): void {
    const entry = this.checkAnchor(a);
    this.anchors.set(a.epoch, a);
    this.append(entry);
  }

  /** Check an anchor without storing it; returns the entry body it would append. */
  checkAnchor(a: EpochAnchor): Buffer {
    if (this.anchors.has(a.epoch)) throw new Error(`epoch ${a.epoch} is already anchored`);
    if (!verifyBytes(this.operator, anchorMessage(a), a.signature)) throw new Error('anchor is not signed by the operator');
    return Buffer.concat([Buffer.from('anchor'), rosterHash(a.epoch, a.roster, this.registry), anchorMessage(a)]);
  }

  /** `proofs` carries the range proofs of the commitments in the total; they are checked, not stored. */
  record(r: RoundRecord, proofs?: ReadonlyMap<MeterId, Uint8Array>): void {
    const unsigned = this.check(r, proofs);
    this.totals.set(`${r.epoch}:${r.round}`, r.total);
    this.append(unsigned);
  }

  /** Check a round record without storing it; returns the entry body it would append. */
  check(r: RoundRecord, proofs?: ReadonlyMap<MeterId, Uint8Array>): Buffer {
    const anchor = this.anchors.get(r.epoch);
    const key = `${r.epoch}:${r.round}`;
    if (!anchor) throw new Error(`epoch ${r.epoch} is not anchored`);
    if (this.totals.has(key)) throw new Error(`round ${key} already has a total`);
    const unsigned = body(r);
    if (!verifyBytes(this.operator, unsigned, r.signature)) throw new Error('record is not signed by the operator');
    const roster = new Set(anchor.roster);
    const signers = new Set<MeterId>();
    const inTotal: Cosigner[] = [];
    for (const c of r.cosigners) {
      const device = this.registry.get(c.id);
      if (!roster.has(c.id) || !device || signers.has(c.id)) continue;
      if (!verifyBytes(device, cosignMessage(r.epoch, r.round, r.activeHash, c.contribution), c.signature)) continue;
      if (!verifyMerkle(leaf(c.id, c.contribution), c.index, r.leaves, c.proof, r.contributionsRoot)) continue;
      if (anchor.rangeBits && (!c.pedersen || !c.digest || !equal(contributionFromDigest(r.epoch, r.round, c.id, c.digest, c.pedersen), c.contribution))) continue;
      signers.add(c.id);
      if (c.inTotal) inTotal.push(c);
    }
    const quorum = Math.floor(roster.size / 2) + 1;
    if (signers.size < quorum) throw new Error(`active set co-signed by ${signers.size} meters, quorum is ${quorum}`);
    if (anchor.rangeBits) {
      if (r.blinding === undefined || !sumsTo(inTotal.map((c) => c.pedersen!), r.total, r.blinding)) {
        throw new Error('total differs from the sum of the co-signed commitments');
      }
      if (this.checkProofs) {
        for (const c of inTotal) {
          const proof = proofs?.get(c.id);
          if (!proof || !verifyRange(c.pedersen!, proof, anchor.rangeBits, proofContext(r.epoch, r.round, c.id))) {
            throw new Error(`no valid range proof for the commitment of meter ${c.id}`);
          }
        }
      }
    }
    return unsigned;
  }

  totalOf(epoch: number, round: number): bigint | undefined {
    return this.totals.get(`${epoch}:${round}`);
  }

  /** Recompute the hash chain over every entry. */
  verifyChain(): boolean {
    let prev = sha256();
    for (const e of this.entries) {
      if (!equal(e.hash, sha256(prev, e.body))) return false;
      prev = e.hash;
    }
    return true;
  }

  /** Stored entry bodies, as a validator would replicate them. */
  get log(): readonly Entry[] {
    return this.entries;
  }

  /** Hash of the last entry: two copies with the same head hold the same log. */
  get head(): Buffer {
    return this.entries.at(-1)?.hash ?? sha256();
  }

  /** Hash the next entry would have if its body were `b`. */
  nextHash(b: Buffer): Buffer {
    return sha256(this.head, b);
  }

  private append(b: Buffer): void {
    const prev = this.entries.at(-1)?.hash ?? sha256();
    this.entries.push({ body: b, hash: sha256(prev, b) });
  }
}

function signedBy(registry: ReadonlyMap<MeterId, Uint8Array>, id: MeterId, message: Uint8Array, signature: Uint8Array): boolean {
  const device = registry.get(id);
  return device !== undefined && verifyBytes(device, message, signature);
}

/**
 * Auditor: recompute a round's total from evidence the operator hands over, using only values the meters signed or
 * committed to, and compare it with the record. Returns the problems found (empty when the record checks out).
 */
export function audit(
  record: RoundRecord,
  evidence: RoundEvidence,
  graph: ReadonlyMap<MeterId, readonly MeterId[]>,
  registry: ReadonlyMap<MeterId, Uint8Array>,
): { total: bigint; problems: string[] } {
  const { epoch, round } = evidence;
  const problems: string[] = [];
  const activeHash = setHash('active', epoch, round, evidence.active);
  if (!equal(activeHash, record.activeHash)) problems.push('active set differs from the recorded hash');
  const active = new Set(evidence.active);
  const final = new Set(evidence.final);
  if (evidence.final.some((i) => !active.has(i))) problems.push('final set is not within the active set');

  const hashes = evidence.contributions.map((c) => contributionHash(epoch, round, c));
  const root = merkleRoot(evidence.contributions.map((c, i) => leaf(c.id, hashes[i]!)));
  if (!equal(root, record.contributionsRoot)) problems.push('contributions differ from the recorded Merkle root');
  evidence.contributions.forEach((c, i) => {
    if (!signedBy(registry, c.id, cosignMessage(epoch, round, activeHash, hashes[i]!), c.signature)) {
      problems.push(`contribution of ${c.id} is not signed by its meter`);
    }
  });

  const finalHash = setHash('final', epoch, round, evidence.final);
  const removals = new Map<MeterId, { value: U64; valueQ?: bigint }>();
  for (const r of evidence.removals) {
    if (!signedBy(registry, r.id, removalMessage(epoch, round, r.id, finalHash, r.value, r.valueQ), r.signature)) {
      problems.push(`removal of ${r.id} is not signed by its meter`);
    } else removals.set(r.id, r);
  }

  let total: U64 = 0n;
  let blinding = 0n;
  const verified = evidence.contributions.some((c) => c.pedersen);
  const byId = new Map(evidence.contributions.map((c) => [c.id, c]));
  for (const i of evidence.final) {
    const c = byId.get(i);
    const secret = evidence.secrets.get(i);
    if (!c || !secret) {
      problems.push(`no contribution or self-mask for ${i}`);
      continue;
    }
    if (!equal(selfMaskCommitment(epoch, round, i, secret), c.commitment)) problems.push(`self-mask of ${i} does not match its commitment`);
    total = sub(sub(add(total, c.y), Buffer.from(secret).readBigUInt64LE(0)), c.correction);
    const removal = graph.get(i)?.some((j) => active.has(j) && !final.has(j)) ? removals.get(i) : undefined;
    if (graph.get(i)?.some((j) => active.has(j) && !final.has(j))) {
      if (removal === undefined) problems.push(`no signed removal from ${i}`);
      else total = sub(total, removal.value);
    }
    if (verified) blinding = modL(blinding + selfBlinding(secret) + (c.correctionQ ?? 0n) + (removal?.valueQ ?? 0n));
  }
  const recomputed = decode(total);
  if (recomputed !== record.total) problems.push(`recorded total ${record.total} differs from recomputed ${recomputed}`);
  if (verified) {
    const commitments = evidence.final.flatMap((i) => (byId.get(i)?.pedersen ? [byId.get(i)!.pedersen!] : []));
    if (!sumsTo(commitments, recomputed, blinding)) problems.push('recomputed total differs from the sum of the committed readings');
    if (record.blinding !== blinding) problems.push('recorded blinding differs from the recomputed one');
  }
  return { total: recomputed, problems };
}
