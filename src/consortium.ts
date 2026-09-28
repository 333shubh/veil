// The audit ledger replicated across independent validators (for example the utility, a regulator and a consumer
// body), each holding its own copy. The operator proposes each anchor and round record to the validators; each checks
// it against its own copy and, if it passes, signs an endorsement of the resulting chain hash. An entry is appended
// everywhere once a quorum endorses the same hash, so no single validator, and no operator showing validators
// different records, can put an entry on the ledger alone. Two operator-signed records for one round are kept as
// proof that the operator equivocated. This models the endorsement policy of a permissioned chain in one process; it is
// not a network deployment.
import { equal, signBytes, verifyBytes, type SigningKey } from './crypto.ts';
import { Ledger, type LedgerOptions, type RoundRecord } from './ledger.ts';
import type { EpochAnchor, MeterId } from './protocol.ts';

export interface Validator {
  name: string;
  key: SigningKey;
  ledger: Ledger;
}

export interface Endorsement {
  validator: string;
  height: number;
  hash: Uint8Array; // chain hash after appending the entry
  signature: Uint8Array;
}

export interface Outcome {
  committed: boolean;
  hash?: Uint8Array; // the committed chain hash
  endorsements: Endorsement[];
  refusals: { validator: string; reason: string }[];
  equivocation?: [RoundRecord, RoundRecord]; // two operator-signed records for one round
}

const endorsementMessage = (height: number, hash: Uint8Array) => {
  const h = Buffer.alloc(4);
  h.writeUInt32BE(height);
  return Buffer.concat([Buffer.from('veil/v1/endorse'), h, hash]);
};

const recordKey = (r: RoundRecord) => `${r.epoch}:${r.round}`;

export class Consortium {
  readonly validators: Validator[];
  readonly quorum: number;
  private readonly seen = new Map<string, RoundRecord>(); // the first operator-signed record seen for each round

  constructor(operator: Uint8Array, registry: ReadonlyMap<MeterId, Uint8Array>, validators: { name: string; key: SigningKey }[], options: LedgerOptions = {}) {
    this.validators = validators.map((v) => ({ ...v, ledger: new Ledger(operator, registry, options) }));
    this.quorum = Math.floor(validators.length / 2) + 1;
  }

  anchor(a: EpochAnchor): Outcome {
    return this.propose(
      () => a,
      (v) => v.ledger.checkAnchor(a),
      (v) => v.ledger.anchor(a),
    );
  }

  /**
   * Propose a round record. `to` lets a dishonest operator send different records to different validators; by default
   * every validator gets `r`. The record a quorum endorses is appended by every validator that also finds it valid.
   */
  record(r: RoundRecord, proofs?: ReadonlyMap<MeterId, Uint8Array>, to?: (v: Validator) => RoundRecord): Outcome {
    const shown = (v: Validator) => (to ? to(v) : r);
    let equivocation: [RoundRecord, RoundRecord] | undefined;
    for (const v of this.validators) {
      const got = shown(v);
      const first = this.seen.get(recordKey(got));
      if (!first) this.seen.set(recordKey(got), got);
      else if (!equal(first.signature, got.signature)) equivocation ??= [first, got];
    }
    const outcome = this.propose(
      shown,
      (v) => v.ledger.check(shown(v), proofs),
      (v, committed) => v.ledger.record(committed as RoundRecord, proofs),
    );
    return equivocation ? { ...outcome, equivocation } : outcome;
  }

  /** Every validator's copy is intact and they all hold the same log. */
  consistent(): boolean {
    const [first, ...rest] = this.validators;
    return this.validators.every((v) => v.ledger.verifyChain()) && rest.every((v) => equal(v.ledger.head, first!.ledger.head));
  }

  private propose<T>(shown: (v: Validator) => T, check: (v: Validator) => Buffer, append: (v: Validator, committed: T) => void): Outcome {
    const endorsements: Endorsement[] = [];
    const refusals: Outcome['refusals'] = [];
    const proposals = new Map<string, { item: T; hash: Uint8Array; by: Endorsement[] }>();
    for (const v of this.validators) {
      try {
        const hash = v.ledger.nextHash(check(v));
        const height = v.ledger.log.length;
        const e = { validator: v.name, height, hash, signature: signBytes(v.key, endorsementMessage(height, hash)) };
        endorsements.push(e);
        const key = Buffer.from(hash).toString('hex');
        if (!proposals.has(key)) proposals.set(key, { item: shown(v), hash, by: [] });
        proposals.get(key)!.by.push(e);
      } catch (err) {
        refusals.push({ validator: v.name, reason: (err as Error).message });
      }
    }
    // Endorsements travel with signatures, so each validator can count them for itself.
    const valid = (e: Endorsement) => verifyBytes(this.validators.find((v) => v.name === e.validator)!.key.publicKey, endorsementMessage(e.height, e.hash), e.signature);
    const winner = [...proposals.values()].find((p) => p.by.filter(valid).length >= this.quorum);
    if (!winner) return { committed: false, endorsements, refusals };
    for (const v of this.validators) {
      try {
        append(v, winner.item);
      } catch (err) {
        if (!refusals.some((x) => x.validator === v.name)) refusals.push({ validator: v.name, reason: (err as Error).message });
      }
    }
    return { committed: true, hash: winner.hash, endorsements, refusals };
  }
}
