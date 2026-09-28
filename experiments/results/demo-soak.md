# Demo soak (Phase 6 gate)

Environment: 13th Gen Intel(R) Core(TM) i5-13450HX (16 threads), win32 10.0.26200, Node v22.10.0, OpenSSL 3.0.15+quic. Engine bundled by demo/build.ts with the browser crypto backend (@noble).

240 simulated homes in 8 meter threads, k=54, t=33; 1% background dropout plus up to 10 homes unplugged at a time.
Run: 690 s wall time (target 600 s), setup 57.8 s.

| rounds | published | exact | mismatches | suppressed | aborted |
|---:|---:|---:|---:|---:|---:|
| 326 | 326 | 326 | 0 | 0 | 0 |

Round wall time (meters in parallel threads, coordinator and ledger in one): median 1781 ms, p95 1928 ms, max 2062 ms.

Tampering: 6/6 second totals rejected by the ledger and flagged by the audit.

Lying meter: a home added 500 kW to its reports in 60 published rounds; the plausibility checks flagged 60 of them, and 3 of the 265 rounds with no liar.

Collusion slider (16 homes, k=6, t=4; survivor-set and final-set attacks over every split of the honest neighbours):

| corrupt neighbours | attempts | victim exposed |
|---:|---:|:---|
| 0 | 128 | no |
| 1 | 64 | no |
| 2 | 32 | no |
| 3 | 16 | no |
| 4 | 8 | yes, by the survivor-set split (2345 W) |
| 5 | 4 | yes, by the survivor-set split (2345 W) |
| 6 | 2 | yes, by the survivor-set split (2345 W) |

Verified-mode group (16 homes, k=6, t=4, 16-bit range proofs), one round per kind of lie:

| the liar | round | liar in the total | published | true sum of the homes included | validators checking every proof |
|---|---|---|---:|---:|---|
| changes its masked value only | aborted: the total differs from the sum of the committed readings |  |  |  |  |
| claims +50 kW (out of range) | published | no | 9495 | 9495 | accepted |
| claims +5 kW (in range) | published | yes | 14832 | 9832 | accepted |

Gate (zero mismatches over at least ten minutes): PASS
