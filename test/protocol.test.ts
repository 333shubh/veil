import { describe, expect, it } from 'vitest';
import { choose, DESIGN } from '../src/params.ts';
import { finalSet, isAborted, type Check, type Confirm, type MeterId } from '../src/protocol.ts';
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
  it('cancels all masks with no dropouts, from revealed self-masks alone', () => {
    const { ids, group, readings, sum } = fixture(11, 12, 4, 3);
    const trace = runRound(group, 1, readings, everyone(ids));
    expect(trace.aborts).toEqual([]);
    expect(trace.result).toMatchObject({ status: 'published', total: sum(ids) });
    expect(trace.requests).toBeUndefined(); // nobody went silent, so no shares are asked for
    if (trace.result.status !== 'published') return;
    expect(trace.result.evidence.contributions.every((c) => c.correction === 0n)).toBe(true);
    expect(trace.result.evidence.removals).toEqual([]);
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
    if (result.status === 'published') expect(result.evidence.removals.length).toBeGreaterThan(0);
  });

  it('rebuilds from shares the self-mask of a meter that checked and then went silent', () => {
    const { ids, group, readings, sum } = fixture(14, 12, 6, 4);
    const trace = runRound(group, 1, readings, { reporting: new Set(ids), confirming: new Set(ids), releasing: without(ids, ids[0]!) });
    expect(trace.result).toMatchObject({ status: 'published', total: sum(ids) });
    expect([...trace.requests!.values()].every((want) => want.size === 1 && want.has(ids[0]!))).toBe(true);
  });

  it('opens the escrowed removal of a meter that must remove masks and went silent after checking', () => {
    const { ids, group, readings, sum } = fixture(15, 12, 6, 4);
    const gone = ids[0]!;
    const neighbour = group.params.graph.get(gone)![0]!;
    const rest = without(ids, gone);
    const trace = runRound(group, 1, readings, { reporting: new Set(ids), confirming: rest, releasing: without(ids, gone, neighbour) });
    expect(trace.result).toMatchObject({ status: 'published', total: sum(rest) });
    if (trace.result.status === 'published') expect(trace.result.evidence.removals.some((r) => r.id === neighbour)).toBe(true);
  });

  it('aborts when a meter that must remove masks goes silent before checking', () => {
    const { ids, group, readings } = fixture(16, 12, 6, 4);
    const gone = ids[0]!;
    const neighbour = group.params.graph.get(gone)![0]!;
    const pattern: Pattern = { reporting: new Set(ids), confirming: without(ids, gone), checking: without(ids, gone, neighbour), releasing: without(ids, gone, neighbour) };
    expect(runRound(group, 1, readings, pattern).result).toMatchObject({
      status: 'aborted',
      reason: `meter ${neighbour} left no removal of its masks with meters that dropped after reporting`,
    });
  });

  it('leaves out a meter with fewer than t live neighbours, which still passes on the shares it holds', () => {
    // Stranding a meter takes out most of its neighbourhood, which on a small graph can empty F; pick a target whose
    // stranding leaves a usable F on this epoch's graph.
    const { ids, group, readings } = fixture(19, 30, 12, 4);
    const graph = group.params.graph;
    const scenario = ids
      .map((target) => {
        const gone = graph.get(target)!.slice(0, 9); // 3 of 12 left: below t
        const active = new Set(ids.filter((id) => !gone.includes(id)));
        const final = finalSet([...active].filter((i) => graph.get(i)!.filter((j) => active.has(j)).length >= 4), graph, 4);
        const silent = graph.get(target)!.find((j) => final.has(j)); // a neighbour in F that goes quiet after checking
        return { target, gone, silent, ok: final.size >= 3 && !final.has(target) && silent !== undefined };
      })
      .find((s) => s.ok)!;
    const { target, gone } = scenario;
    const silent = scenario.silent!;
    const rest = without(ids, ...gone);
    const trace = runRound(group, 1, readings, { reporting: rest, confirming: rest, releasing: without([...rest], silent) });
    expect(trace.result.status).toBe('published');
    if (trace.result.status !== 'published') return;
    const final = trace.result.evidence.final;
    expect(final).not.toContain(target);
    expect(final).toContain(silent);
    expect(trace.unmasks.some((u) => u.id === target && u.shares.has(silent))).toBe(true);
    expect(trace.result.total).toBe(final.reduce((acc, id) => acc + readings.get(id)!, 0n));
  });

  it('suppresses totals below the minimum group size', () => {
    const { ids, group, readings } = fixture(17, 6, 2, 2);
    const two = new Set(ids.slice(0, 2));
    expect(runRound(group, 1, readings, { reporting: two, confirming: two, releasing: two }).result).toEqual({ status: 'suppressed' });
  });

  it('confirms, checks and releases at most once per round, and holds one final set', () => {
    const { ids, group, readings } = fixture(18, 6, 2, 2);
    const meter = group.meters.get(ids[0]!)!;
    meter.report(3, readings.get(ids[0]!)!);
    const all = new Set(ids);
    expect(isAborted(meter.confirm(3, all))).toBe(false);
    expect(meter.confirm(3, without(ids, ids[1]!))).toEqual({ aborted: 'not waiting for an active set' });
    expect(isAborted(meter.check(3, all, []))).toBe(false);
    expect(meter.check(3, without(ids, ids[1]!), [])).toEqual({ aborted: 'not waiting for a final set' });
    expect(meter.release(3, [])).toEqual({ aborted: 'only 0 neighbours agree on the final set, need 2' });
    expect(meter.release(3, [])).toEqual({ aborted: 'not waiting to release' });
  });

  it("does not count a meter's own agreement MAC reflected back as its neighbour's", () => {
    const { ids, group, readings } = fixture(20, 8, 2, 2);
    const all = new Set(ids);
    const a = ids[0]!;
    const [b, c] = group.params.graph.get(a)!;
    for (const id of ids) group.meters.get(id)!.report(4, readings.get(id)!);
    const confirms = ids.map((id) => group.meters.get(id)!.confirm(4, all)).filter((x): x is Confirm => !isAborted(x));
    const own = group.meters.get(a)!.check(4, all, confirms.filter((x) => group.params.graph.get(a)!.includes(x.id))) as Check;
    const reflect = (from: MeterId): Check => ({ ...own, id: from, agree: new Map([[a, own.agree.get(from)!]]) });
    expect(group.meters.get(a)!.release(4, [reflect(b!), reflect(c!)])).toEqual({ aborted: `final set differs from neighbour ${b}'s` });
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
