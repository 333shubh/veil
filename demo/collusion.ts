// The collusion slider: a small separate group (16 homes, k = 6, t = 4) where a malicious coordinator corrupts
// `corrupt` of a target's neighbours and runs the survivor-set attack over every split of the honest ones.
import { splits, survivorSet } from '../src/adversary.ts';
import { setupGroup } from '../src/simulation.ts';

export interface CollusionResult {
  corrupt: number;
  t: number;
  splits: number;
  exposed: boolean;
  guess?: string;
  truth: string;
}

export class Collusion {
  private readonly group = setupGroup(Array.from({ length: 16 }, (_, i) => i + 1), 1, 6, 4);
  private round = 1;

  attack(corrupt: number, reading: bigint): CollusionResult {
    const g = this.group;
    const victim = g.ids[0]!;
    const neighbours = g.params.graph.get(victim)!;
    const bad = new Set(neighbours.slice(0, corrupt));
    const honest = neighbours.filter((j) => !bad.has(j));
    const readings = new Map(g.ids.map((id) => [id, id === victim ? reading : 150n]));
    let guess: bigint | undefined;
    const outcomes = splits(honest).map((dropped) => {
      const o = survivorSet(g, victim, bad, dropped, this.round++, false, readings);
      if (o.unmasked) guess = o.guess;
      return o;
    });
    const t = g.params.threshold;
    return { corrupt, t, splits: outcomes.length, exposed: outcomes.some((o) => o.unmasked), guess: guess?.toString(), truth: reading.toString() };
  }
}
