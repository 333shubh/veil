# Veil: private neighbourhood totals for Indian smart meters

Final report. Veil lets a distribution utility read the exact total load of a group of homes every round while each home's reading stays masked [S12]. This repository builds it end to end in TypeScript: the protocol core, the experiments that measure it, and a browser demo that runs the same core. Every number below comes from a result file under `experiments/results/`, from the code that fixes it, or from a source in `docs/sources.md`. The tag after each statement says which; `npm run trace` checks them.

## 1. Summary

- **Exact.** Every published total equals the true sum of the homes it covers: in the exactness gate over 10,000 random rounds with signed readings and dropouts [exactness], in every E4 round that published, from 0% to 50% random dropout [E4], and in the demo's ten-minute soak run [soak].
- **Private against the attacks that were run.** The survivor-set attack fails for every split of a target's neighbours while fewer than t are corrupted, and succeeds once t are, as the analysis predicts [attacks] [soak]. A classifier on the coordinator's view scores 48.0% ± 5.7 at telling two reading vectors with the same total apart, against 100.0% ± 5.7 on raw readings [indist].
- **Cheap for a meter.** Masking one report costs a median 0.148 ms at k = 38 against 9.739 ms for a Paillier-2048 encryption on the same machine, and a report is 32 bytes [E1].
- **Sized from Indian data.** The design dropout rate of 10% sits above the 8.9% and 6.9% mean daily-epoch loss measured on CEEW meters in Mathura and Bareilly [dropout] [params]. A water-pump detector that works on one home (AUC 0.991) falls to 0.535 on a total of 200 homes, which sets the minimum group size at 200 [E5].
- **Not free.** The coordinator's work grows faster than linearly (exponent 1.35) [E3]; a crash between protocol phases can abort a round (45 of 100 in the E4 crash test) [E4]; and setup for 200 meters costs 13057.7 ms of CPU on one machine [E8].

## 2. What was built

The components, from protocol core to demo [demo]:

| part | where | what it does |
|---|---|---|
| Ring and masks | `src/ring.ts`, `src/crypto.ts` | Readings as two's-complement values in `Z_{2^64}`; ChaCha20 masks keyed per pair and per epoch, with epoch and round as the nonce |
| Keys | `src/crypto.ts`, `src/protocol.ts` | X25519 combined with ML-KEM-768 for every pair key; HKDF-SHA256; device Ed25519 signatures on epoch keys |
| Sharing | `src/shamir.ts` | Shamir sharing of each round's self-mask secret over the prime field `GF(2^256 + 297)`, shares sealed with ChaCha20-Poly1305 |
| Graph | `src/graph.ts` | Random Harary graph from a public seed, so every meter has k uniformly chosen neighbours |
| Parameters | `src/params.ts` | Exact failure probabilities; chooses k and t for a group size (E7) |
| Protocol | `src/protocol.ts` | Report, close, confirm (signed active set), collect, release, recover; per-round MACs; epoch key ratchet |
| Ledger | `src/ledger.ts` | Operator-signed epoch anchor; one total per round with a majority of co-signatures; hash-chained log; auditor recomputation |
| Load simulator | `src/load.ts` | Appliance-level load for Indian homes in summer, checked against CEEW and iAWE |
| Demo | `demo/` | Three.js city of 240 homes; the protocol runs in browser workers |

Deviations from the specification [S12], each forced or chosen deliberately:

- **TypeScript instead of Rust and WebAssembly.** The specification allows a TypeScript port as a shortcut. The browser demo bundles the same TypeScript with a pure-JavaScript crypto backend (`src/crypto.browser.ts`, tested byte for byte against the Node backend).
- **No hardware measurements.** No Raspberry Pi or microcontroller was available, so all timings are from one laptop. Per-meter costs on meter-class hardware remain unmeasured.
- **A signed active set in every round.** Shares of each round's self-mask are dealt after the active set is fixed, so a meter never releases both kinds of recovery value for one neighbour in one round. The survivor-set attack then needs t corrupt neighbours [attacks].
- **An in-process ledger, not Hyperledger Fabric.** `src/ledger.ts` implements what the chaincode would check (one total per round, co-signature quorum, Merkle root of contributions, hash chain), without distributing it across validators.
- **Plain Three.js instead of React.** The demo has one page and no component tree, so React would add a dependency and nothing else.

## 3. Correctness

The Phase 1 gate publishes 10,000 random rounds, with readings of both signs and random dropout patterns, and requires each total to equal the true sum bit for bit [exactness]. It passed, and passed again after each protocol change.

Recovery under dropout, 200 meters with k = 54 and t = 33 [E4]:

| dropout | rounds | published | exact | reporters included |
|---|---|---|---|---|
| 0% | 20 | 20 | 20 | 100.0% |
| 10% | 20 | 20 | 20 | 100.0% |
| 30% | 20 | 20 | 20 | 95.0% |
| 40% | 20 | 20 | 20 | 52.1% |
| 50% | 20 | 10 | 10 | 9.0% |

A meter joins the total only when at least t of its neighbours are live, because it deals its self-mask to them; past that point it is left out and its masks are removed, so the round still publishes an exact total of the others [E4]. With crashes between phases (10% dropout, then 1% before confirming and 1% before releasing), 55 of 100 rounds published, all exact, and 45 aborted [E4]. A round aborts rather than publish a wrong total.

## 4. Security

**Neighbourhood size.** E7 computes exact failure probabilities for a random Harary graph and chooses k and t for each group size at the design point: 20% of meters corrupt, 10% dropout, privacy failure at most 2^-40 per group per epoch, and a meter left out of a round at most 2^-20 per group per round [E7] [params].

| N | 50 | 100 | 200 | 500 | 1000 | 2000 | 5000 | 10000 |
|---|---|---|---|---|---|---|---|---|
| k | 32 | 38 | 54 | 64 | 68 | 74 | 76 | 80 |
| t | 17 | 21 | 33 | 40 | 43 | 47 | 48 | 51 |

No k meets both bounds for groups of 10 or 20: even the complete graph leaves a meter out too often [E7]. Monte Carlo runs of 2000 trials per row agree with the exact model [E7].

**Attack replays.** The survivor-set attack, in which the coordinator tells some neighbours that the victim dropped and others that it reported, fails for every split of the victim's honest neighbours when fewer than t are corrupted; with t corrupted it succeeds, which shows the replay is a real attack [attacks]. Relaying the conflicting confirmations makes honest meters abort [attacks]. Values released in one round never unmask another [attacks]. The demo's collusion slider replays the same attack on a group of 16 homes with k = 6 and t = 4: the target stays hidden with up to 3 corrupt neighbours and is exposed with 4 [soak].

**What the operator sees.** 50 meters, two reading vectors with the same total, 1000 rounds with 10% dropout: a logistic regression on everything the coordinator can strip from each meter's value reaches 48.0% ± 5.7, at chance, while the same classifier on raw readings reaches 100.0% ± 5.7 [indist].

**Tampering.** The ledger accepts one total per round, and only with co-signatures of the active set from a majority of the roster. A second total for a recorded round is rejected, and the auditor recomputing from signed evidence flags a false total or forged evidence [attacks]. The demo repeats this during its soak run [soak].

## 5. Cost

Per meter, one laptop core [E1]:

| operation | median (ms) | p95 (ms) | bytes |
|---|---|---|---|
| Veil report, k = 38 | 0.148 | 0.240 | 32 |
| Veil report, k = 80 | 0.296 | 0.436 | 32 |
| Veil whole round, k = 38 | 1.703 | 1.934 | |
| Veil whole round, k = 80 | 4.360 | 8.939 | |
| Paillier-1024 encryption | 1.338 | 1.577 | 280 |
| Paillier-2048 encryption | 9.739 | 12.4 | 536 |

The whole round adds the confirmation (one Ed25519 co-signature, shares, neighbour MACs) and the release to the report [E1]. At k = 54 a meter sends 6164 bytes and receives 7278 bytes per round with no dropouts [E2]. Setup sends 32748 bytes per meter per epoch at k = 54, mostly ML-KEM keys and encapsulations [E2].

Operator per round, 10% dropout [E3]:

| N | k | coordinator median (ms) |
|---|---|---|
| 100 | 38 | 61.2 |
| 200 | 54 | 214.0 |
| 500 | 64 | 703.4 |
| 1000 | 68 | 1579.0 |
| 2000 | 74 | 3821.4 |

The growth exponent is 1.35, against 2.72 on a complete graph [E3]. It is above 1 because k and t grow with N and rebuilding each self-mask from t shares costs time quadratic in t [claims].

**Going sparse.** At N = 200, the sparse graph (k = 54) needs 27% of the complete graph's setup, 19% of its meter time, 13% of its coordinator time and 30% of its bytes [E8], in line with the 20 to 30 percent that Choi et al. report [S3]. The saving grows with N [E8].

## 6. Privacy in Indian homes

**Dropout.** CEEW's 2020 data has 38 meters in Mathura and 45 in Bareilly reporting every 3 minutes [dropout] [S4]. With a daily epoch, the mean share of the roster missing per round is 8.9% in Mathura and 6.9% in Bareilly; power cuts make it bursty, with a p99 of 47.8% and 42.9% [dropout]. The 10% design rate covers the mean, and E4 shows the tail: rounds at 40% dropout still publish exact totals, with fewer homes included [E4].

**Load.** The simulator matches CEEW's daily consumption (median 9.48 kWh simulated against 9.74 measured) and its hour-of-day shape (correlation 0.91), and takes appliance sizes from the iAWE house in Delhi (pump 667 W simulated against 710 W measured) [load] [S5]. Its hourly shape is sharper than CEEW's in the morning, and its air-conditioners cycle more often than iAWE's [load].

**Minimum group size (E5).** The attack looks for one home's water pump switching on, in 5-minute windows, with the pump's wattage known [E5]:

| observation | homes | AUC |
|---|---|---|
| raw readings | 1 | 0.991 |
| group total | 20 | 0.779 |
| group total | 50 | 0.625 |
| group total | 100 | 0.578 |
| group total | 200 | 0.535 |
| group total | 500 | 0.494 |
| masked reports | 1 | 0.500 |

The criterion, fixed before the run, was an AUC of at most 0.6 at the top of its 95% interval; 200 is the smallest group size that meets it, and Veil suppresses totals over fewer meters [E5] [params].

**Forecasting (E6).** Veil's totals equal the exact totals in all 288 rounds checked, so a next-day peak forecast from them has the same error as the exact one, 4.13% [E6]. That is a property of exact aggregation, not a finding. Differential privacy with Laplace noise on each total costs 591.06% error at epsilon 0.1, 30.52% at epsilon 1 and 4.25% at epsilon 10 [E6].

## 7. Demo

`npm run demo` serves a Three.js city of 240 simulated homes around their transformer [demo]. The engine plays coordinator and ledger in one browser worker, and the meters run in eight more, reached only by messages. Modes: Raw (homes lit by their own load), Veil (homes neutral, total moving), Operator (masked values next to the decoded total), an always-on invariant counter, unplugging a home by clicking it, the collusion slider, the group-size slider over E5's results, a billing channel, and an audit view where the operator republishes an altered total.

Phase 6 gate: the engine, bundled with the browser crypto backend and run under Node worker threads, ran for ten minutes with 1% background dropout and up to 10 homes unplugged at a time [soak]:

| rounds | published | exact | mismatches | tampered totals caught |
|---|---|---|---|---|
| 307 | 307 | 307 | 0 | 6/6 |

Pure-JavaScript elliptic-curve code is much slower than OpenSSL, so the demo's setup and rounds are slower than the benchmarks: setup took 34.3 s and a round a median of 1918 ms, with the meters in 8 threads [soak]. The benchmarks use Node's native crypto [E1] [E8].

## 8. The original claims, measured

`experiments/results/claims.md` lists each claim from the original write-up against its measurement [claims]. In short: masking costs under 1 ms per report, but a meter's whole round costs 1.703 ms at k = 38; Paillier's "50 ms" is replaced by 1.338 ms (1024-bit) and 9.739 ms (2048-bit) on the same machine; the operator's work is not linear as measured; and the sparse graph's saving is measured for Veil itself [claims].

## 9. Limitations

- **No meter-class hardware.** All timings come from one laptop. The per-report cost on a meter microcontroller, the item a utility would ask about first, is unmeasured.
- **The coordinator is superlinear.** Its round time grows with exponent 1.35, and one round for 2000 meters takes 3821.4 ms on one core [E3]. Larger feeders need more than one group, or parallel recovery.
- **Set announcements grow with N.** Each meter receives the full active and final sets, 1608 bytes per round at N = 200 [E2]. Sending a neighbour bitmap and a hash would cap this; it is not implemented.
- **Crashes between phases abort rounds.** In E4's crash test 45 of 100 rounds aborted [E4]. Nothing wrong is published, but the operator loses those rounds; a retry path is not built.
- **Dropout is bursty in India.** Power cuts take many meters at once, with a p99 of 47.8% of a roster missing in Mathura [dropout]. Past about 40% dropout most homes fall out of the total [E4].
- **Recovery adds latency.** Every round has two exchanges after the deadline, whether or not anyone dropped [E4]. At every-few-seconds reporting an operator must choose between a late exact total and a provisional one.
- **Privacy is probabilistic.** The chance of a bad neighbourhood is bounded at 2^-40 per group per epoch at the design point, not zero, and the bound assumes at most 20% of meters corrupt [E7] [params].
- **The total still leaks.** Totals of small groups, and changes in membership, expose homes. Veil enforces a minimum of 200 [params], but that number comes from one attack (pump detection) on simulated homes [E5]; other appliances or a better attacker could need more.
- **The simulator is not a household.** It matches CEEW's group statistics and iAWE's appliances, but iAWE is one house, and CEEW covers 83 homes in two districts of one state [load].
- **Malicious meters are not handled.** A meter can report any value; masking hides it. Range proofs (as in ACORN [S13]) are the fix and are not built.
- **Per-meter functions leave the private channel.** Outage, tamper and theft detection and per-customer demand response need individual data. Billing needs a second, coarse channel that is still personal data (DATA-PROTECTION.md).
- **Setup is heavy.** A 200-meter epoch costs 13057.7 ms of CPU across the group and 32748 bytes sent per meter [E8] [E2]; key storage, device certificates and meter replacement are not built.
- **Browser crypto is slow.** In the demo, pure-JavaScript X25519 and Ed25519 dominate; setup takes 34.3 s for 240 homes [soak].
- **The ledger is not distributed.** It checks what the chaincode would check, but runs in one process.
- **Prior work was not compared.** Won et al. (2014) is the closest prior art for fault-tolerant meter aggregation and was not read for this report [S14].

## 10. Reproduce

```
npm install
npm test                  # unit, protocol, hardening and attack tests
npm run test:exactness    # Phase 1 gate: 10,000 random rounds (about 16 minutes)
npm run e1                # and e2, e3, e4, e7, e8, claims, india-dropout, load-validation, e5, e6, indistinguishability
npm run demo:soak -- 600  # Phase 6 gate
npm run demo              # the demo on http://localhost:8000
npm run trace             # Phase 7 gate: every number in this report traces
```

The Indian datasets are not in the repository: CEEW [S4] and iAWE [S5] go under `$VEIL_DATA` (default `~/veil-data`). Each result file records its machine, Node and OpenSSL versions, seed and run time.

Sources are listed in `docs/sources.md`. The data-protection note is `DATA-PROTECTION.md`.
