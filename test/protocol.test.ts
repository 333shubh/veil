import { describe, expect, it } from 'vitest';
import { choose, DESIGN } from '../src/params.ts';
import { isAborted, type MeterId } from '../src/protocol.ts';
import { distinctIds, everyone, Rng, runRound, setupGroup, type Pattern } from './support.ts';

function fixture(seed: number, n: number, k: number, t: number) {
  const rng = new Rng(seed);
  const ids = distinctIds(rng, n);
  const group = setupGroup(ids, 7, k, t);
  const readings = new Map<MeterId, bigint>(ids.map((id) => [id, BigInt(rng.int(-5_000, 20_000))]));
  const sum = (set: Iterable<MeterId>) => [...set].reduce((acc, id) => acc + readings.get(id)!, 0n);
  return { rng, ids, group, readings, sum };
}

const without = (ids: MeterId[], ...drop: MeterId[]) => new Set(ids.filter((id) => !drop.includes(id)));

describe('Veil round', () => {
  it('cancels all masks with no dropouts', () => {
    const { ids, group, readings, sum } = fixture(11, 12, 4, 3);
    const { result, aborts } = runRound(group, 1, readings, everyone(ids));
    expect(aborts).toEqual([]);
    expect(result).toMatchObject({ status: 'published', total: sum(ids) });
    if (result.status !== 'published') return;
    expect(result.evidence.contributions.every((c) => c.correction === 0n)).toBe(true);
    expect(result.evidence.extras).toEqual([]);
  });

  it('removes the masks of a meter that never reported', () => {
    const { ids, group, readings, sum } = fixture(12, 12, 6, 4);
    const rest = without(ids, ids[0]!);
    expect(runRound(group, 1, readings, { reporting: rest, confirming: rest, releasing: rest }).result).toMatchObject({ status: 'published', total: sum(rest) });
  });

  it('leaves out a meter that reported but never confirmed', () => {
    const { ids, group, readings, sum } = fixture(13, 12, 6, 4);
    const rest = without(ids, ids[0]!);
    const { result } = runRound(group, 1, readings, { reporting: new Set(ids), confirming: rest, releasing: rest });
    expect(result).toMatchObject({ status: 'published', total: sum(rest) });
    if (result.status === 'published') expect(result.evidence.extras.length).toBeGreaterThan(0);
  });

  it('rebuilds the self-mask of a meter that confirmed but never released', () => {
    const { ids, group, readings, sum } = fixture(14, 12, 6, 4);
    const { result } = runRound(group, 1, readings, { reporting: new Set(ids), confirming: new Set(ids), releasing: without(ids, ids[0]!) });
    expect(result).toMatchObject({ status: 'published', total: sum(ids) });
  });

  it('aborts when a meter that must remove masks does not release', () => {
    const { ids, group, readings } = fixture(15, 12, 6, 4);
    const gone = ids[0]!;
    const neighbour = group.params.graph.get(gone)![0]!;
    const pattern: Pattern = { reporting: new Set(ids), confirming: without(ids, gone), releasing: without(ids, gone, neighbour) };
    expect(runRound(group, 1, readings, pattern).result.status).toBe('aborted');
  });

  it('leaves out a meter with fewer than t live neighbours, which still passes on the shares it holds', () => {
    const { ids, group, readings } = fixture(19, 16, 6, 4);
    const target = ids[0]!;
    const gone = group.params.graph.get(target)!.slice(0, 3); // 3 of 6 left: below t
    const rest = without(ids, ...gone);
    const trace = runRound(group, 1, readings, { reporting: rest, confirming: rest, releasing: rest });
    expect(trace.result.status).toBe('published');
    if (trace.result.status !== 'published') return;
    const final = trace.result.evidence.final;
    expect(final).not.toContain(target);
    expect(trace.releases.some((r) => r.id === target && r.shares.size > 0)).toBe(true);
    expect(trace.result.total).toBe(final.reduce((acc, id) => acc + readings.get(id)!, 0n));
  });

  it('suppresses totals below the minimum group size', () => {
    const { ids, group, readings } = fixture(16, 6, 2, 2);
    const two = new Set(ids.slice(0, 2));
    expect(runRound(group, 1, readings, { reporting: two, confirming: two, releasing: two }).result).toEqual({ status: 'suppressed' });
  });

  it('confirms and releases at most once per round', () => {
    const { ids, group, readings } = fixture(17, 6, 2, 2);
    const meter = group.meters.get(ids[0]!)!;
    meter.report(3, readings.get(ids[0]!)!);
    const all = new Set(ids);
    expect(isAborted(meter.confirm(3, all))).toBe(false);
    expect(meter.confirm(3, without(ids, ids[1]!))).toEqual({ aborted: 'not waiting for an active set' });
    expect(isAborted(meter.release(3, all, []))).toBe(false);
    expect(meter.release(3, without(ids, ids[1]!), [])).toEqual({ aborted: 'not waiting to release' });
  });

  it('stays exact on a 100-meter group with the chosen k and t', () => {
    const rng = new Rng(18);
    const ids = distinctIds(rng, 100);
    const { k, t } = choose(100, DESIGN)!;
    const group = setupGroup(ids, 9, k, t);
    for (let round = 0; round < 3; round++) {
      const readings = new Map<MeterId, bigint>(ids.map((id) => [id, BigInt(rng.int(-5_000, 20_000))]));
      const reporting = new Set(ids.filter(() => !rng.chance(DESIGN.dropout)));
      const total = [...reporting].reduce((acc, id) => acc + readings.get(id)!, 0n);
      expect(runRound(group, round, readings, { reporting, confirming: reporting, releasing: reporting }).result).toMatchObject({ status: 'published', total });
    }
  }, 30_000);
});
