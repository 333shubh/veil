// Household load simulator for Indian homes in summer: appliance-level power for each home at a fixed interval, for
// the privacy experiments and the demo's raw view. Appliance sizes and cycles follow the iAWE house in Delhi; ownership
// and habits are set so that group statistics match CEEW's smart-meter data from Uttar Pradesh (checked by
// experiments/load-validation.ts).
import { hkdf, u32Stream } from './crypto.ts';
import type { MeterId } from './protocol.ts';

export type Appliance = 'ac' | 'pump' | 'iron' | 'mixer' | 'induction' | 'washer';

export interface ApplianceEvent {
  home: MeterId;
  appliance: Appliance;
  start: number; // sample index
  end: number; // exclusive
  watts: number;
}

export interface Load {
  interval: number; // seconds per sample
  samples: number;
  power: Map<MeterId, Int32Array>; // watts per sample; negative is rooftop solar export
  events: ApplianceEvent[];
}

const DAY = 86_400;

/** Simulate `homes` for `days` of summer at one sample every `interval` seconds, reproducibly from `seed`. */
export function simulateLoad(homes: readonly MeterId[], days: number, interval: number, seed: string): Load {
  const next = u32Stream(hkdf(Buffer.from(seed), Buffer.from('veil/load/india')));
  const u = () => next() / 2 ** 32;
  const between = (lo: number, hi: number) => lo + u() * (hi - lo);
  const perDay = Math.round(DAY / interval);
  const samples = perDay * days;
  const at = (day: number, hour: number) => Math.round(day * perDay + (hour * 3600) / interval);
  const span = (minutes: number) => Math.max(1, Math.round((minutes * 60) / interval));
  const power = new Map<MeterId, Int32Array>();
  const events: ApplianceEvent[] = [];

  for (const home of homes) {
    const p = new Float64Array(samples);
    const add = (from: number, to: number, watts: number) => {
      for (let i = Math.max(0, from); i < Math.min(samples, to); i++) p[i]! += watts;
    };
    const event = (appliance: Appliance, start: number, length: number, watts: number) => {
      add(start, start + length, watts);
      if (start >= 0 && start < samples) events.push({ home, appliance, start, end: Math.min(samples, start + length), watts });
    };
    /** A thermostat or on/off cycle through a window, e.g. a fridge or an AC compressor. */
    const cycle = (from: number, to: number, watts: number, on: [number, number], off: [number, number], appliance?: Appliance) => {
      for (let i = from + Math.floor(u() * span(off[1])); i < to; ) {
        const length = Math.min(span(between(...on)), to - i);
        if (appliance) event(appliance, i, length, watts);
        else add(i, i + length, watts);
        i += length + span(between(...off));
      }
    };

    // Household make-up: a few homes use very little (single rooms, frequent absence), some use a lot (several ACs).
    const size = u() < 0.2 ? 0.25 : 1;
    const base = between(30, 90) * size;
    const fans = Math.round(between(1.5, 4.5) * size) || 1;
    const fanWatts = between(50, 75);
    const hasFridge = u() < 0.85 * (size < 1 ? 0.5 : 1);
    const fridgeWatts = between(85, 130);
    const acs = size < 1 ? 0 : u() < 0.4 ? (u() < 0.4 ? 2 : 1) : 0;
    const acWatts = [between(1500, 1800), between(1500, 1800)];
    // As in iAWE: some units cycle every few minutes on the thermostat, others run long stretches.
    const acCycle: [number, number][][] = [0, 1].map(() => (u() < 0.5 ? [[2, 6], [2, 5]] : [[15, 60], [5, 15]]));
    const hasCooler = acs === 0 && u() < 0.6 * size;
    const coolerWatts = between(150, 220);
    const pumpWatts = u() < 0.6 ? between(600, 750) : 0;
    const hasWasher = u() < 0.5 * size;
    const ironWatts = u() < 0.5 * size ? between(900, 1200) : 0;
    const mixerWatts = between(500, 750);
    const inductionWatts = u() < 0.3 * size ? between(1200, 1800) : 0;
    const solar = u() < 0.05 ? between(2000, 3000) : 0;

    add(0, samples, base);
    if (hasFridge) cycle(0, samples, fridgeWatts, [5, 15], [8, 20]);

    for (let d = 0; d < days; d++) {
      // Fans run most of the day and night; each fan switches every half hour or so, on its own clock.
      for (let f = 0; f < fans; f++) {
        const phase = between(0, 0.5);
        for (let i = at(d, phase - 0.5); i < at(d + 1, phase - 0.5); i += span(30)) if (u() < 0.85) add(i, i + span(30), fanWatts);
      }
      // Lights and television, switched on and off at each home's own times, not in unison.
      for (let i = at(d, between(18, 19.25)), end = at(d, between(22.5, 24)); i < end; i += span(15)) add(i, Math.min(end, i + span(15)), between(100, 300) * size);
      for (let i = at(d, between(5, 6)), end = at(d, between(6.5, 7.75)); i < end; i += span(15)) add(i, Math.min(end, i + span(15)), between(30, 100) * size);
      const sessions = Math.round(between(1, 4));
      for (let s = 0; s < sessions; s++) {
        const start = at(d, u() < 0.3 ? between(11, 14) : between(18, 22.5));
        add(start, start + span(between(20, 90)), between(60, 110));
      }
      // Cooling: ACs cycle through the night and some afternoons; coolers run long stretches.
      for (let a = 0; a < acs; a++) {
        const [on, off] = acCycle[a]!;
        if (u() < 0.8) cycle(at(d, between(21, 24)), at(d + 1, between(1, 8)), acWatts[a]!, on!, off!, 'ac');
        if (u() < 0.65) cycle(at(d, between(11, 14)), at(d, between(16, 18.5)), acWatts[a]!, on!, off!, 'ac');
      }
      if (hasCooler) {
        if (u() < 0.9) add(at(d, between(21, 24)), at(d + 1, between(2, 8)), coolerWatts);
        if (u() < 0.9) add(at(d, between(9, 12)), at(d, between(16, 18.5)), coolerWatts);
      }
      // Water pump: short runs to fill the overhead tank, mostly early morning.
      if (pumpWatts) {
        const runs = u() < 0.3 ? 2 : 1;
        for (let r = 0; r < runs; r++) event('pump', at(d, u() < 0.6 ? between(5.5, 8) : between(18, 21)), span(between(0.5, 3)), pumpWatts);
      }
      // Kitchen: mixer-grinder bursts around meals, sometimes an induction hob.
      const grinds = Math.round(between(0, 3));
      for (let g = 0; g < grinds; g++) {
        const slot = u();
        event('mixer', at(d, slot < 0.5 ? between(7, 9) : slot < 0.7 ? between(12, 13) : between(19, 20.5)), span(between(1, 4)), mixerWatts);
      }
      if (inductionWatts && u() < 0.4) event('induction', at(d, u() < 0.5 ? between(7, 9) : between(19, 21)), span(between(10, 25)), inductionWatts);
      // Laundry and ironing, mostly in the morning.
      if (hasWasher && u() < 0.4) event('washer', at(d, between(7, 11)), span(between(15, 40)), between(200, 450));
      if (ironWatts && u() < 0.25) event('iron', at(d, u() < 0.6 ? between(7, 10) : between(15, 19)), span(between(5, 15)), ironWatts);
      // Rooftop solar in a few homes.
      if (solar) {
        const cloud = between(0.5, 1);
        for (let block = at(d, 6); block < at(d, 18.5); block += span(5)) {
          const passing = between(0.8, 1);
          for (let i = block; i < Math.min(block + span(5), at(d, 18.5)); i++) {
            const hour = ((i - d * perDay) * interval) / 3600;
            p[i]! -= solar * cloud * passing * Math.max(0, Math.sin((Math.PI * (hour - 6)) / 12.5));
          }
        }
      }
    }
    power.set(home, Int32Array.from(p, Math.round));
  }
  events.sort((a, b) => a.start - b.start);
  return { interval, samples, power, events };
}
