# Demo soak (Phase 6 gate)

Environment: 13th Gen Intel(R) Core(TM) i5-13450HX (16 threads), win32 10.0.26200, Node v22.10.0, OpenSSL 3.0.15+quic. Engine bundled by demo/build.ts with the browser crypto backend (@noble).

240 simulated homes in 8 meter threads, k=54, t=33; 1% background dropout plus up to 10 homes unplugged at a time.
Run: 642 s wall time (target 600 s), setup 34.3 s.

| rounds | published | exact | mismatches | suppressed | aborted |
|---:|---:|---:|---:|---:|---:|
| 307 | 307 | 307 | 0 | 0 | 0 |

Round wall time (meters in parallel threads, coordinator and ledger in one): median 1918 ms, p95 2151 ms, max 2379 ms.

Tampering: 6/6 second totals rejected by the ledger and flagged by the audit.

Collusion slider (16 homes, k=6, t=4; every split of the honest neighbours):

| corrupt neighbours | splits | victim exposed |
|---:|---:|:---|
| 0 | 64 | no |
| 1 | 32 | no |
| 2 | 16 | no |
| 3 | 8 | no |
| 4 | 4 | yes (2345 W) |
| 5 | 2 | yes (2345 W) |
| 6 | 1 | yes (2345 W) |

Gate (zero mismatches over at least ten minutes): PASS
