# Final-set split on the Phase 7 protocol

Replayed on 2026-09-28 against commit 509252a (Phase 7, before the fix) with `npx vitest run` on the test below. Group of 16 meters, k = 6, t = 4, no corrupt meters. The coordinator announces the honest active set to everyone, shows the victim a final set F that holds none of its neighbours, and shows each neighbour the honest F.

Output: `[final-split on Phase 7 code] guess 2331, truth 2331`: the victim is unmasked with 0 corrupt neighbours.

Why: the victim released, as its "extra", the sum of its masks with every neighbour it was told is outside F, while each neighbour, told the victim is in F, released its share of the victim's self-mask. Nothing made the two views of F agree. The fix (Phase 8) is the agreement check in `src/protocol.ts`; `test/attacks.test.ts` replays the same split against it.

```ts
// Replay against the Phase 7 protocol: a coordinator shows the victim a final set F that holds none of its neighbours,
// and shows every neighbour the honest F. No meter is corrupted.
import { expect, it } from 'vitest';
import { isAborted, type Confirm } from '../src/protocol.ts';
import { combine } from '../src/shamir.ts';
import { decode, sub } from '../src/ring.ts';
import { distinctIds, Rng, setupGroup } from './support.ts';

it('final-set split unmasks the victim with no corrupt meters', () => {
  const rng = new Rng(7);
  const ids = distinctIds(rng, 16);
  const g = setupGroup(ids, 1, 6, 4);
  const victim = ids[0]!;
  const nbrs = g.params.graph.get(victim)!;
  const readings = new Map(ids.map((id) => [id, BigInt(rng.int(-5000, 20000))]));
  const round = 1;
  const y = new Map(ids.map((id) => [id, g.meters.get(id)!.report(round, readings.get(id)!).y]));
  const all = new Set(ids);
  const confirms = new Map<number, Confirm>();
  for (const id of ids) { const c = g.meters.get(id)!.confirm(round, all); if (!isAborted(c)) confirms.set(id, c); }
  const victimFinal = new Set(ids.filter((id) => !nbrs.includes(id)));
  const inboxFor = (id: number) => [...confirms.values()].filter((c) => g.params.graph.get(id)!.includes(c.id));
  const rv = g.meters.get(victim)!.release(round, victimFinal, inboxFor(victim));
  if (isAborted(rv)) throw new Error(rv.aborted);
  const shares = nbrs.map((j) => {
    const r = g.meters.get(j)!.release(round, all, inboxFor(j));
    if (isAborted(r)) throw new Error(r.aborted);
    return { x: BigInt(j), y: r.shares.get(victim)! };
  });
  const self = Buffer.from(combine(shares, g.params.threshold)).readBigUInt64LE(0);
  const guess = decode(sub(sub(sub(y.get(victim)!, self), confirms.get(victim)!.correction), rv.extra!.value));
  console.log(`[final-split on Phase 7 code] guess ${guess}, truth ${readings.get(victim)}`);
  expect(guess).toBe(readings.get(victim));
});
```
