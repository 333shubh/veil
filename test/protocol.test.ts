import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { harary } from '../src/graph.ts';
import { choose, DESIGN } from '../src/params.ts';
import type { GroupParams, MeterId } from '../src/protocol.ts';
import { distinctIds, randomGraph, Rng, runRound, setupGroup } from './support.ts';

function fixture(seed: number, n: number, k: number, t: number) {
  const rng = new Rng(seed);
  const ids = distinctIds(rng, n);
  const params: GroupParams = { epoch: 7, threshold: t, minGroupSize: 3, graph: randomGraph(rng, ids, k) };
  const readings = new Map<MeterId, bigint>(ids.map((id) => [id, BigInt(rng.int(-5_000, 20_000))]));
  const sum = (set: Iterable<MeterId>) => [...set].reduce((acc, id) => acc + readings.get(id)!, 0n);
  return { rng, ids, params, readings, sum, group: setupGroup(params) };
}

describe('Veil round', () => {
  it('cancels all masks with no dropouts, rebuilding no mask keys', () => {
    const { ids, readings, sum, group } = fixture(11, 12, 4, 3);
    const all = new Set(ids);
    const { result, releases } = runRound(group, 1, readings, all, all);
    expect(result).toEqual({ status: 'published', total: sum(all) });
    expect(releases.every((r) => r.maskKey.size === 0)).toBe(true);
  });

  it("removes a dropped meter's dangling pairwise masks", () => {
    const { ids, readings, sum, group } = fixture(12, 12, 6, 4);
    const reporting = new Set(ids.slice(1));
    const { result, releases } = runRound(group, 1, readings, reporting, reporting);
    expect(result).toEqual({ status: 'published', total: sum(reporting) });
    expect(releases.some((r) => r.maskKey.has(ids[0]!))).toBe(true);
  });

  it('suppresses totals below the minimum group size', () => {
    const { ids, readings, group } = fixture(13, 6, 3, 2);
    const two = new Set(ids.slice(0, 2));
    expect(runRound(group, 1, readings, two, two).result).toEqual({ status: 'suppressed' });
  });

  it('aborts instead of publishing when fewer than t neighbours answer', () => {
    const { ids, readings, params, group } = fixture(14, 8, 3, 2);
    const target = ids[0]!;
    const all = new Set(ids);
    const responding = new Set(ids.filter((id) => !params.graph.get(target)!.includes(id)));
    expect(runRound(group, 1, readings, all, responding).result.status).toBe('aborted');
  });

  it('never releases shares twice in one round', () => {
    const { ids, group } = fixture(15, 5, 2, 2);
    const meter = group.meters.get(ids[0]!)!;
    meter.release(3, new Set(ids));
    expect(() => meter.release(3, new Set(ids.slice(1)))).toThrow(/already released/);
  });

  it('stays exact on a generated graph with the chosen k and t', () => {
    const rng = new Rng(16);
    const ids = distinctIds(rng, 100);
    const { k, t } = choose(100, DESIGN)!;
    const group = setupGroup({ epoch: 9, threshold: t, minGroupSize: 3, graph: harary(ids, k, randomBytes(32)) });
    for (let round = 0; round < 5; round++) {
      const readings = new Map<MeterId, bigint>(ids.map((id) => [id, BigInt(rng.int(-5_000, 20_000))]));
      const reporting = new Set(ids.filter(() => !rng.chance(DESIGN.dropout)));
      const total = [...reporting].reduce((acc, id) => acc + readings.get(id)!, 0n);
      expect(runRound(group, round, readings, reporting, reporting).result).toEqual({ status: 'published', total });
    }
  });
});
