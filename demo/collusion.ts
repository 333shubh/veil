// The collusion slider: a small separate group (16 homes, k = 6, t = 4) where a malicious coordinator corrupts
// `corrupt` of a target's neighbours and runs both view-splitting attacks over every split of the honest ones: the
// survivor-set attack (neighbours shown different active sets) and the final-set split (shown different final sets).
import { finalSplit, splits, survivorSet } from '../src/adversary.ts';
import { setupGroup } from '../src/simulation.ts';

export interface CollusionResult {
  corrupt: number;
  t: number;
  splits: number; // attempts across both attacks
  exposed: boolean;
  by?: 'survivor-set' | 'final-set'; // the attack that exposed the target, if any
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
    let found: { by: CollusionResult['by']; guess: bigint } | undefined;
    let attempts = 0;
    for (const subset of splits(honest)) {
      for (const [by, outcome] of [
        ['survivor-set', () => survivorSet(g, victim, bad, subset, this.round++, false, readings)],
        ['final-set', () => finalSplit(g, victim, bad, subset, this.round++, readings)],
      ] as const) {
        attempts++;
        const o = outcome();
        if (o.unmasked && !found) found = { by, guess: o.guess! };
      }
    }
    const t = g.params.threshold;
    return { corrupt, t, splits: attempts, exposed: found !== undefined, by: found?.by, guess: found?.guess.toString(), truth: reading.toString() };
  }
}
