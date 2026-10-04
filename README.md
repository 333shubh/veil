# Veil

Private neighbourhood totals for smart meters. A distribution utility reads the exact total load of a group of homes every few seconds, while each home's reading stays masked. Veil is a double-masked secure sum over a sparse neighbour graph. It adds threshold recovery for meters that drop, a check that stops the coordinator showing meters different views, an optional verified mode that catches out-of-range inputs, and an audit ledger replicated across validators.

- **[REPORT.md](REPORT.md)**: the final report, with results, cost and limitations. Every number in it traces to an experiment or a source (`npm run trace`).
- **[docs/rounds.md](docs/rounds.md)**: the round, message by message, and the security argument for its agreement check.
- **[DATA-PROTECTION.md](DATA-PROTECTION.md)**: a note for a distribution utility in India.
- **[VEIL_RESEARCH.md](VEIL_RESEARCH.md)**: the specification this build follows.

## Layout

| path | what |
|---|---|
| `src/protocol.ts` | meters and the untrusted coordinator: report, confirm, check, release, unmask, recover |
| `src/crypto.ts`, `src/crypto.browser.ts` | X25519 + ML-KEM-768, HKDF, ChaCha20, ChaCha20-Poly1305, Ed25519, HMAC (Node and browser backends) |
| `src/shamir.ts`, `src/ring.ts`, `src/graph.ts` | secret sharing, arithmetic mod 2^64, the random Harary graph |
| `src/params.ts` | chooses k and t (E7), the minimum group size (E5), verified-mode and plausibility constants |
| `src/pedersen.ts`, `src/plausibility.ts` | verified mode's commitments and range proofs; the default plausibility checks |
| `src/ledger.ts`, `src/consortium.ts` | the audit ledger, the auditor, and the ledger replicated across validators |
| `src/adversary.ts` | a malicious coordinator and lying meters, for replayed attacks |
| `src/load.ts` | household load simulator for Indian homes in summer |
| `experiments/` | E1 to E9 and the supporting experiments; results in `experiments/results/` |
| `demo/` | the website: a scroll story told as a pop-up paper city (`demo/landing/`), ending in a live feeder of 240 meters running the real protocol in workers; `demo/classic.html` is the original control-panel demo |
| `test/` | unit, protocol, attack, verified-mode and ledger tests, and the exactness gate |

## Run

Needs Node 22 or later.

```
npm install
npm test                  # everything but the exactness gate (about 15 s)
npm run test:exactness    # 10,000 random rounds against an independent oracle
npm run demo              # the website on http://localhost:8000 (the classic demo at /classic.html)
npm run e1                # ... e9, claims, india-dropout, load-validation, indistinguishability
npm run demo:soak -- 600  # the demo engine for ten minutes, counting mismatches
npm run trace             # checks that every number in the report, the data-protection note and the website traces
```

The Indian datasets (CEEW smart-meter data from Mathura and Bareilly, and the iAWE house) are not in the repository. Put them under `$VEIL_DATA`, which defaults to `~/veil-data`. Only `india-dropout` and `load-validation` read them.
