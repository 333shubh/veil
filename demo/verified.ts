// The lying-meter panel's verified-mode group: 16 homes (k = 6, t = 4) in verified mode, where one meter lies in one of
// three ways and a round shows what the coordinator and the validators make of it.
import { makeLiar } from '../src/adversary.ts';
import { Ledger, recordFor } from '../src/ledger.ts';
import { VERIFIED_BITS } from '../src/params.ts';
import type { MeterId, RoundEvidence } from '../src/protocol.ts';
import { everyone, runRound, setupGroup, type Group } from '../src/simulation.ts';

export type LieKind = 'masked' | 'claimed' | 'inRange';

export interface VerifiedResult {
  kind: LieKind;
  lie: string; // W added
  status: 'published' | 'suppressed' | 'aborted';
  reason?: string;
  liarIncluded: boolean;
  total?: string; // W, as published
  honest?: string; // W, the true sum of the homes in the total
  validators?: string; // what validators checking every proof say
}

const LIES: Record<LieKind, bigint> = { masked: 50_000n, claimed: 50_000n, inRange: 5_000n };

export class VerifiedDemo {
  private round = 1;
  private readonly groups = new Map<LieKind, Group>();

  run(kind: LieKind): VerifiedResult {
    let g = this.groups.get(kind);
    const ids: MeterId[] = Array.from({ length: 16 }, (_, i) => i + 1);
    const liar = ids[0]!;
    if (!g) {
      g = setupGroup(ids, 1, 6, 4, 3, { rangeBits: VERIFIED_BITS });
      if (kind === 'inRange') {
        const m = g.meters.get(liar)!;
        const honest = m.report.bind(m);
        m.report = (round, reading) => honest(round, reading + LIES.inRange);
      } else makeLiar(g, liar, kind === 'masked' ? { masked: LIES.masked } : { claimed: LIES.claimed });
      this.groups.set(kind, g);
    }
    const readings = new Map(ids.map((id) => [id, 300n + BigInt(id) * 37n]));
    const trace = runRound(g, this.round++, readings, everyone(ids));
    const r = trace.result;
    const out: VerifiedResult = { kind, lie: LIES[kind].toString(), status: r.status, liarIncluded: false };
    if (r.status === 'aborted') out.reason = r.reason;
    if (r.status !== 'published') return out;
    const { total, evidence } = r as { total: bigint; evidence: RoundEvidence };
    out.liarIncluded = evidence.final.includes(liar);
    out.total = total.toString();
    out.honest = evidence.final.reduce((a, id) => a + readings.get(id)!, 0n).toString();
    const strict = new Ledger(g.operator.publicKey, g.registry, { checkProofs: true });
    strict.anchor(g.anchor);
    try {
      strict.record(recordFor(g.operator, evidence, total), new Map(trace.reports.map((x) => [x.id, x.proof!])));
      out.validators = 'accepted';
    } catch (e) {
      out.validators = `refused: ${(e as Error).message}`;
    }
    return out;
  }
}
