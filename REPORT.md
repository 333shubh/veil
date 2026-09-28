# Veil: private neighbourhood totals for Indian smart meters

Final report. Veil lets a distribution utility read the exact total load of a group of homes every round while each home's reading stays masked [S12]. This repository builds it end to end in TypeScript: the protocol core, the experiments that measure it, and a browser demo that runs the same core. Every number below comes from a result file under `experiments/results/`, from the code that fixes it, or from a source in `docs/sources.md`. The tag after each statement says which; `npm run trace` checks them.

Phase 8 changed the protocol after the Phase 7 write-up. Replaying a new attack showed that the Phase 7 round let a malicious coordinator unmask a home with no corrupt meters [split]. Section 4 describes the flaw and the fix. Every experiment below was re-run on the fixed protocol.

## 1. Summary

- **Exact.** Every published total equals the true sum of the homes it covers: in the exactness gate over 10,000 random rounds with signed readings and dropouts [exactness], in every E4 round that published, from 0% to 50% random dropout [E4], and in the demo's ten-minute soak run [soak].
- **Private against the attacks that were run.** A final-set split unmasked a home in the Phase 7 round with no corrupt meters [split]. In the current round, that split and the survivor-set attack both fail for every split of a target's neighbours while fewer than t are corrupted, and succeed once t are, as the analysis predicts [attacks] [rounds]. A classifier on the coordinator's view scores 54.0% ± 5.6 at telling two reading vectors with the same total apart, against 100.0% ± 5.7 on raw readings [indist].
- **Cheap for a meter.** Masking one report costs a median 0.128 ms at k = 38 against 8.198 ms for a Paillier-2048 encryption on the same machine, and a report is 32 bytes [E1].
- **Linear for the operator.** Meters reveal their own round secrets once t neighbours agree on the final set, so the coordinator rebuilds from shares only for meters that go silent. Its round time grows with exponent 1.03, 295.4 ms for 2000 meters [E3].
- **Sized from Indian data.** The design dropout rate of 10% sits above the 8.9% and 6.9% mean daily-epoch loss measured on CEEW meters in Mathura and Bareilly [dropout] [params]. A water-pump detector that works on one home (AUC 0.990) falls to 0.532 on a total of 200 homes, which sets the minimum group size at 200 [E5].
- **Lying meters are caught only in part.** Plausibility checks on each total catch a sudden lie of 20 kW or more, and no smaller one [E9]. In verified mode, range proofs and a check of every total against the meters' commitments catch every inconsistent or out-of-range lie. A false reading within range passes, and the proofs are slow in pure JavaScript [E9].
- **Not free.** Rounds collapse under heavy dropout: at k = 54, 7 of 20 rounds publish at 30% dropout and none at 40% [E4]. A crash in the window before the check aborts a round (49 of 100 in the E4 crash test) [E4]. Setup for 200 meters costs 11905.4 ms of CPU on one machine [E8].

## 2. What was built

The components, from protocol core to demo [demo]:

| part | where | what it does |
|---|---|---|
| Ring and masks | `src/ring.ts`, `src/crypto.ts` | Readings as two's-complement values in `Z_{2^64}`; ChaCha20 masks keyed per pair and per epoch, with epoch and round as the nonce |
| Keys | `src/crypto.ts`, `src/protocol.ts` | X25519 combined with ML-KEM-768 for every pair key; HKDF-SHA256; device Ed25519 signatures on epoch keys |
| Sharing | `src/shamir.ts` | Shamir sharing of each round's self-mask secret and escrow key over the prime field `GF(2^256 + 297)`, shares sealed with ChaCha20-Poly1305 |
| Graph | `src/graph.ts` | Random Harary graph from a public seed, so every meter has k uniformly chosen neighbours |
| Parameters | `src/params.ts` | Exact failure probabilities; chooses k and t for a group size (E7); the minimum group size (E5); verified-mode and plausibility constants (E9) |
| Protocol | `src/protocol.ts` | Report, close, confirm (signed active set), collect, check (neighbours agree on the final set), release, and unmask when a meter goes silent; per-round MACs; epoch key ratchet |
| Verified mode | `src/pedersen.ts` | Pedersen commitments on ristretto255 and range proofs; the aggregate check of each total against the commitments |
| Plausibility | `src/plausibility.ts` | Checks of each published total's mean load per home and its change between rounds |
| Ledger | `src/ledger.ts`, `src/consortium.ts` | Operator-signed epoch anchor; one total per round with a majority of co-signatures; hash-chained log; auditor recomputation; the same ledger replicated across validators with an endorsement quorum |
| Load simulator | `src/load.ts` | Appliance-level load for Indian homes in summer, checked against CEEW and iAWE |
| Demo | `demo/` | Three.js city of 240 homes; the protocol runs in browser workers |

`docs/rounds.md` gives the round message by message and the security argument for it [rounds].

Deviations from the specification [S12], each forced or chosen deliberately:

- **TypeScript instead of Rust and WebAssembly.** The specification allows a TypeScript port as a shortcut. The browser demo bundles the same TypeScript with a pure-JavaScript crypto backend (`src/crypto.browser.ts`, tested byte for byte against the Node backend).
- **No hardware measurements.** No Raspberry Pi or microcontroller was available, so all timings are from one laptop. Per-meter costs on meter-class hardware remain unmeasured.
- **Shares dealt per round, after the active set is fixed.** A meter deals shares of each round's self-mask only to neighbours that reported, so a meter never releases both kinds of recovery value for one neighbour in one round. The specification deals shares of long-term seeds at epoch setup instead [attacks].
- **A check step that the specification does not have.** The final set F, the meters whose self-masks can be recovered, is Veil's own addition, and it needs its own consistency check (Section 4) [rounds].
- **An in-process ledger, not Hyperledger Fabric.** `src/consortium.ts` replicates `src/ledger.ts` across validators and commits an entry only when a quorum endorses it. That is the chaincode's endorsement policy, run in one process rather than over a network [consortium].
- **Plain Three.js instead of React.** The demo has one page and no component tree, so React would add a dependency and nothing else.

## 3. Correctness

The Phase 1 gate publishes 10,000 random rounds, with readings of both signs and random dropout patterns, and requires each total to equal the true sum bit for bit [exactness]. An independent oracle in the test predicts every round's outcome. The gate passed, and passed again after each protocol change, including the agreement round.

Recovery under random dropout before the deadline, 200 meters with k = 54 and t = 33 [E4]:

| dropout | rounds | published | exact | reporters included |
|---|---|---|---|---|
| 0% | 20 | 20 | 20 | 100.0% |
| 10% | 20 | 20 | 20 | 100.0% |
| 20% | 20 | 20 | 20 | 100.0% |
| 25% | 20 | 18 | 18 | 90.0% |
| 30% | 20 | 7 | 7 | 35.0% |
| 40% | 20 | 0 | 0 | 0.0% |

A meter joins the final set F if at least t of its neighbours reported, since it deals its self-mask to them. It must also have t neighbours in F, since it must hear agreement on F from t of them before it releases anything. Meters that fail either test are left out and their masks removed [E4]. The second rule is the price of the fix in Section 4. When too many meters drop, leaving meters out cascades until F falls below the minimum and the round is suppressed [E4].

Crashes after the deadline, on top of 10% dropout [E4]:

| meters go silent | rounds | published | exact | aborted | opened an escrowed removal |
|---|---|---|---|---|---|
| 1% before confirming, and 1% before checking | 100 | 51 | 51 | 49 | 0 |
| 1% before confirming, and 1% after checking | 100 | 100 | 100 | 0 | 50 |
| 1% at all three points | 100 | 51 | 51 | 49 | 13 |

A meter that goes silent after its check costs nothing. Its round secret is rebuilt from its neighbours' shares, and its removal (the masks it shares with meters that reported but left F) is opened from an escrow whose key its agreeing neighbours hold [E4]. A round still aborts when such a meter goes silent before its check, because then it never escrowed the removal [E4]. A round aborts rather than publish a wrong total.

## 4. Security

**Neighbourhood size.** E7 computes exact failure probabilities for a random Harary graph and chooses k and t for each group size at the design point: 20% of meters corrupt, 10% dropout, privacy failure at most 2^-40 per group per epoch, and a meter left out of a round at most 2^-20 per group per round [E7] [params].

| N | 50 | 100 | 200 | 500 | 1000 | 2000 | 5000 | 10000 |
|---|---|---|---|---|---|---|---|---|
| k | 32 | 38 | 54 | 64 | 68 | 74 | 76 | 80 |
| t | 17 | 21 | 33 | 40 | 43 | 47 | 48 | 51 |

No k meets both bounds for groups of 10 or 20: even the complete graph leaves a meter out too often [E7]. Monte Carlo runs of 2000 trials per row agree with the exact model [E7].

**The flaw in the Phase 7 round.** In Phase 7, a meter received the final set F with the request to release, and sent at once its removal and its shares of its neighbours' self-masks. Nothing made two neighbours' views of F agree. A coordinator could show a victim an F without any of its neighbours, so the victim removed every mask it had, while showing the neighbours the true F, so they passed on the victim's self-mask shares. Replayed against the Phase 7 code, this recovered the victim's reading exactly (2331 W) with no corrupt meters [split].

**The fix.** A check step now follows the announcement of F. Each meter fixes one view of the active and final sets for the round and MACs it to each neighbour, naming sender and receiver. A meter releases anything that depends on F only after t of its F neighbours sent the same view. Those t neighbours never remove the masks they share with it, so revealing its secret exposes nothing, and one of them is honest while fewer than t are corrupt [rounds]. The same agreement makes the specification's unproven fast path safe: once t neighbours agree, a meter reveals its own round secret, and the coordinator rebuilds from shares only for meters that go silent [rounds]. F is never changed after the check. Re-checking a smaller F would let the coordinator reuse neighbours' earlier agreement, which cuts the attack's requirement from t corrupt neighbours to 2t - k [rounds].

**Attack replays.** The survivor-set attack shows neighbours different active sets. The final-set split shows them different final sets. Both fail for every split of the victim's honest neighbours when fewer than t are corrupted, and both succeed with t corrupted, which shows the replays are real attacks [attacks]. Relaying the conflicting confirmations makes honest meters abort [attacks]. Values released in one round never unmask another [attacks]. The demo's collusion slider runs both attacks on a group of 16 homes with k = 6 and t = 4: the target stays hidden with up to 3 corrupt neighbours and is exposed with 4 [soak].

**What the operator sees.** 50 meters, two reading vectors with the same total, 1000 rounds with 10% dropout: a logistic regression on everything the coordinator can strip from each meter's value reaches 54.0% ± 5.6, at chance, while the same classifier on raw readings reaches 100.0% ± 5.7 [indist].

**Tampering.** The ledger accepts one total per round, and only with co-signatures of the active set from a majority of the roster. A second total for a recorded round is rejected, and the auditor recomputing from signed evidence flags a false total or forged evidence [attacks]. Replicated across three validators with a quorum of two, an entry commits only when two endorse the same chain hash. An operator that shows one validator a different total leaves two operator-signed records for one round as proof, and the validator catches up with the quorum. One that shows each validator a different total commits nothing [consortium]. In verified mode the validators also refuse any total that is not the sum of the co-signed commitments [consortium] [verified].

## 5. Cost

Per meter, one laptop core [E1]:

| operation | median (ms) | p95 (ms) | bytes |
|---|---|---|---|
| Veil report, k = 38 | 0.128 | 0.320 | 32 |
| Veil report, k = 80 | 0.252 | 0.652 | 32 |
| Veil whole round, k = 38 | 1.921 | 4.768 | |
| Veil whole round, k = 80 | 3.759 | 8.727 | |
| Paillier-1024 encryption | 1.097 | 3.019 | 280 |
| Paillier-2048 encryption | 8.198 | 19.7 | 536 |

The whole round adds the confirmation (one Ed25519 co-signature, shares, neighbour MACs), the check (a MAC to each neighbour) and the release (the meter's own round secret) to the report [E1]. At k = 54 a meter sends 5318 bytes and receives 8752 bytes per round with no dropouts, and 6495 and 9025 in rounds that recover from 10% dropout plus meters going silent before confirming and after checking [E2]. The announced sets travel as bitmaps over the roster, 29 bytes each at N = 200 [E2]. Setup sends 32748 bytes per meter per epoch at k = 54, mostly ML-KEM keys and encapsulations [E2].

Operator per round, 10% dropout [E3]:

| N | k | coordinator median (ms) | with 1% silent after checking (ms) |
|---|---|---|---|
| 100 | 38 | 15.0 | 13.8 |
| 200 | 54 | 29.0 | 31.4 |
| 500 | 64 | 73.4 | 79.4 |
| 1000 | 68 | 185.8 | 172.8 |
| 2000 | 74 | 295.4 | 305.1 |

The growth exponent is 1.03, and 1.04 with meters going silent; Paillier-2048 grows with exponent 0.77 [E3]. Faster share combination (one batched inversion per rebuild) keeps the fallback cheap when a meter does go silent [E3].

**Going sparse.** At N = 200, the sparse graph (k = 54) needs 27% of the complete graph's setup, 22% of its meter time, 84% of its coordinator time and 28% of its bytes [E8]. The coordinator's saving is small now that it no longer rebuilds every self-mask. Setup, meter time and bytes are where the sparse graph pays, in line with the 20 to 30 percent that Choi et al. report [E8] [S3].

## 6. Privacy in Indian homes

**Dropout.** CEEW's 2020 data has 38 meters in Mathura and 45 in Bareilly reporting every 3 minutes [dropout] [S4]. With a daily epoch, the mean share of the roster missing per round is 8.9% in Mathura and 6.9% in Bareilly; power cuts make it bursty, with a p99 of 47.8% and 42.9% [dropout]. The 10% design rate covers the mean, but the tail does not survive at k = 54: rounds are suppressed above about 25% dropout [E4]. A larger neighbourhood buys tolerance. With the smallest threshold that meets the privacy bound, k = 80 publishes every round at 30% dropout and 7 of 10 at 40%; the complete graph publishes every round at 40% [E4].

**Load.** The simulator matches CEEW's daily consumption (median 8.92 kWh simulated against 9.74 measured) and its hour-of-day shape (correlation 0.92), and takes appliance sizes from the iAWE house in Delhi (pump 674 W simulated against 710 W measured) [load] [S5]. Phase 8 stopped every simulated home switching its lights and fans in the same second. That lockstep had moved the group's load in steps no real feeder shows. Its air-conditioners still cycle more often than iAWE's [load].

**Minimum group size (E5).** The attack looks for one home's water pump switching on, in 5-minute windows, with the pump's wattage known [E5]:

| observation | homes | AUC |
|---|---|---|
| raw readings | 1 | 0.990 |
| group total | 20 | 0.768 |
| group total | 50 | 0.650 |
| group total | 100 | 0.591 |
| group total | 200 | 0.532 |
| group total | 500 | 0.528 |
| masked reports | 1 | 0.500 |

The criterion, fixed before the run, was an AUC of at most 0.6 at the top of its 95% interval; 200 is the smallest group size that meets it, and Veil suppresses totals over fewer meters [E5] [params].

**Forecasting (E6).** Veil's totals equal the exact totals in all 288 rounds checked, so a next-day peak forecast from them has the same error as the exact one, 4.42% [E6]. That is a property of exact aggregation, not a finding. Differential privacy with Laplace noise on each total costs 772.13% error at epsilon 0.1, 47.24% at epsilon 1 and 4.51% at epsilon 10 [E6].

## 7. Lying meters

Masking hides each input, so a meter can report any value, and the total moves by its lie [E9].

**Plausibility checks, the default.** Bounds come from one simulated day of 200 homes at 10-second rounds: the mean load per home must lie in [44, 885] W and move at most 79 W per round [E9] [params]. On a second day with no liar, 0 of 8640 rounds were flagged. One lying meter was caught every time from 20 kW, if its lie started suddenly. A lie ramped up over 10 minutes was caught only from 200 kW every time, and no lie of 10 kW or less was ever caught [E9].

**Verified mode.** Each report carries a Pedersen commitment to its reading and a 16-bit range proof, from -32768 to 32767 W [E9] [params]. Each meter's blinding is built like its masks, so the coordinator can check every total against the sum of the commitments without learning any one blinding. With one liar in a group of 50 [E9]:

| the liar | proofs checked | rounds | aborted | liar left out | lie published |
|---|---|---|---|---|---|
| changes its masked value only | 100.0% | 10 | 10 | 0 | 0 |
| claims an out-of-range reading | 100.0% | 10 | 0 | 10 | 0 |
| claims an out-of-range reading | 10.0% | 100 | 0 | 9 | 91 |
| claims a false reading within range | 100.0% | 10 | 0 | 0 | 10 |

Validators checking every proof refused all 91 lies that the sampling coordinator missed [E9]. A false reading within range is a valid reading as far as any proof can tell, so theft by under-reporting needs the billing channel [E9].

The cost is high in pure JavaScript. A proof is 1776 bytes and takes a median 53.3 ms to make and 56.8 ms to check [E9]. For 200 meters, checking every proof takes the coordinator 11940.1 ms per round, and checking 10% takes 1403.8 ms [E9]. At every-few-seconds reporting, verified mode needs sampled checks at the coordinator, with validators checking the rest later, or native code; native code was not measured.

## 8. Demo

`npm run demo` serves a Three.js city of 240 simulated homes around their transformer [demo]. The engine plays coordinator and ledger in one browser worker, and the meters run in eight more, reached only by messages. Modes: Raw (homes lit by their own load), Veil (homes neutral, total moving), and Operator (masked values next to the decoded total). An invariant counter is always on. Clicking a home unplugs it. Other panels: the collusion slider running both split attacks, the group-size slider over E5's results, a billing channel, a lying meter with plausibility checks and a verified-mode group, and an audit view where the operator republishes an altered total.

Phase 6 gate, re-run on the Phase 8 engine. The engine was bundled with the browser crypto backend and run under Node worker threads for ten minutes, with 1% background dropout, up to 10 homes unplugged at a time, and at times a home lying by 500 kW [soak]:

| rounds | published | exact | mismatches | tampered totals caught |
|---|---|---|---|---|
| 326 | 326 | 326 | 0 | 6/6 |

The plausibility checks flagged all 60 published rounds in which a home added 500 kW, and 3 of the 265 rounds with no liar [soak]. The false alarms come from the demo stepping a simulated minute per round, when the bounds were set for 10-second rounds [soak] [E9].

Pure-JavaScript elliptic-curve code is much slower than OpenSSL, so the demo's setup and rounds are slower than the benchmarks: setup took 57.8 s and a round a median of 1781 ms, with the meters in 8 threads [soak]. The benchmarks use Node's native crypto [E1] [E8].

## 9. The original claims, measured

`experiments/results/claims.md` lists each claim from the original write-up against its measurement [claims]. In short: masking costs under 1 ms per report, but a meter's whole round costs 1.921 ms at k = 38. Paillier's "50 ms" is replaced by 1.097 ms (1024-bit) and 8.198 ms (2048-bit) on the same machine. The operator's work is linear as measured. The fast path holds once neighbours agree on the final set. Range proofs catch out-of-range inputs but not in-range lies [claims].

## 10. Related work: Won et al.

Won, Ma, Yau and Rao are the closest prior work on fault-tolerant aggregation for smart meters [S14]. From their abstract, their protocol guarantees differential privacy and handles fail-stop faults proactively with "future ciphertexts", sharing secret keys among the meters [S14]. The two designs differ in what they publish. Differential privacy adds noise, and in E6's forecast Laplace noise at epsilon 1 per total costs 47.24% error against 4.42% for exact totals [E6]. Veil publishes the exact total and relies on the minimum group size instead [E5]. Both designs share trust among meters. The full paper could not be retrieved, so no comparison of cost or fault tolerance is made here [S14].

## 11. Limitations

- **No meter-class hardware.** All timings come from one laptop. The per-report cost on a meter microcontroller, the item a utility would ask about first, is unmeasured.
- **Heavy dropout suppresses rounds.** At k = 54, 7 of 20 rounds publish at 30% dropout and none at 40% [E4]. CEEW's p99 loss is 47.8% in Mathura [dropout]. Feeders with power cuts need a larger k, and k = 80 publishes every round at 30% [E4].
- **The graph cascades locally.** Dropping 22 of one meter's 54 neighbours empties F on the random Harary graph, and so suppresses the whole group's round. A random circulant graph of the same degree keeps 99.4% of reporters [E4]. Veil keeps the Harary graph because E7's partition bound is derived for it.
- **One crash window remains.** A meter that must remove masks and goes silent before its check aborts the round: 49 of 100 rounds in E4's crash test [E4]. The round cannot re-check a smaller F without weakening its security bound [rounds].
- **Recovery adds latency.** Every round has three exchanges after the deadline, and a fourth when a meter goes silent [E4]. At every-few-seconds reporting an operator must choose between a late exact total and a provisional one.
- **Privacy is probabilistic.** The chance of a bad neighbourhood is bounded at 2^-40 per group per epoch at the design point, not zero, and the bound assumes at most 20% of meters corrupt [E7] [params].
- **The total still leaks.** Totals of small groups, and changes in membership, expose homes. Veil enforces a minimum of 200 [params], but that number comes from one attack (pump detection) on simulated homes [E5]; other appliances or a better attacker could need more.
- **The simulator is not a household.** It matches CEEW's group statistics and iAWE's appliances, but iAWE is one house, and CEEW covers 83 homes in two districts of one state [load].
- **Lying meters are only partly handled.** Plausibility checks miss lies below 20 kW [E9]. Verified mode catches out-of-range and inconsistent lies but not in-range ones, and in pure JavaScript its proofs cost 11940.1 ms of coordinator time per 200-meter round if all are checked [E9].
- **Per-meter functions leave the private channel.** Outage, tamper and theft detection and per-customer demand response need individual data. Billing needs a second, coarse channel that is still personal data (DATA-PROTECTION.md).
- **Setup is heavy.** A 200-meter epoch costs 11905.4 ms of CPU across the group and 32748 bytes sent per meter [E8] [E2]; key storage, device certificates and meter replacement are not built.
- **Browser crypto is slow.** In the demo, pure-JavaScript X25519 and Ed25519 dominate; setup takes 57.8 s for 240 homes [soak].
- **The ledger is replicated in one process.** Validators check and endorse independently, but they are not networked [consortium].

## 12. Reproduce

```
npm install
npm test                  # unit, protocol, attack, verified-mode and ledger tests
npm run test:exactness    # Phase 1 gate: 10,000 random rounds
npm run e1                # and e2 ... e9, claims, india-dropout, load-validation, indistinguishability
npm run demo:soak -- 600  # Phase 6 gate
npm run demo              # the demo on http://localhost:8000
npm run trace             # Phase 7 gate: every number in this report traces
```

The Indian datasets are not in the repository: CEEW [S4] and iAWE [S5] go under `$VEIL_DATA` (default `~/veil-data`). Each result file records its machine, Node and OpenSSL versions, seed and run time.

Sources are listed in `docs/sources.md`. The data-protection note is `DATA-PROTECTION.md`.
