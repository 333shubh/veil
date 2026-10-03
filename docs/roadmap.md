# Roadmap: from research prototype to a system a utility can adopt

Phases 1 to 8 answered the research question: a utility can read exact group totals without seeing any home. This roadmap lists the remaining work before a distribution utility (discom) could deploy Veil. It covers every limitation in REPORT.md section 11 except meter-hardware timing, and the gaps a review against Indian smart-metering practice found (2026-10-04).

Each item has its own branch and pull request, and ends at a gate, as the phases did. Status is one of open, in progress or done.

## What the review found

Four facts about Indian metering change the plan:

- **Groups are larger than transformers.** Veil publishes totals only for 200 or more homes [params]. India has 34.18 crore consumers and 1.51 crore distribution transformers (DTs), about 23 consumers per DT [R1]. Discoms do energy accounting at DT level [R2], so a minimum of 200 rules out Veil's most valuable use until a DT-level output is designed.
- **Reads are every 15 minutes.** Indian AMI collects 96 interval reads per meter per day [R3]. REPORT.md assumes reporting every few seconds.
- **Bandwidth.** At k = 54 a meter sends 5318 bytes and receives 8752 bytes per round [E2]. At 96 rounds a day that is about 1.3 MB per meter per day, to deliver 96 readings of 8 bytes each. Most meters reach the head-end over RF mesh through gateways or over NB-IoT [R3] [R4].
- **The interfaces are fixed.** Meters talk to the head-end system (HES) in IS 15959 (DLMS/COSEM); the HES talks to the meter data management system (MDM) in IEC 61968-9 messages; meter keys travel as PKCS#7 key files, and the HES must support key rotation [R4]. Consumers must be given their own consumption data through an app, website or SMS [R5].

## Items

### A. Foundations

| # | item | source | gate | status |
|---|---|---|---|---|
| 1 | Continuous integration: typecheck, tests, exactness gate and trace on every push; a software bill of materials and dependency audit | new | CI passes on main and blocks a failing pull request | open |
| 2 | Read the papers so far cited from abstracts or reference lists (Won et al. [S14], Acs and Castelluccia, EPPA, Shi et al.) and rewrite the related-work comparison | §11 | Every comparison rests on the full text | open |

### B. Fit to Indian utilities

These come first because they can change the round's shape.

| # | item | source | gate | status |
|---|---|---|---|---|
| 3 | Define the outputs a discom gets: for example 15-minute totals per feeder of 200+ homes, and daily or monthly energy per DT for energy accounting, each with a minimum group size measured for its time resolution | new | Every output has a measured privacy level | open |
| 4 | 15-minute rounds and vector rounds: one protocol round carrying many readings, so its overhead is paid once; compare bytes per meter per day against RF-mesh and NB-IoT budgets | new | Daily traffic per meter fits a stated network budget | open |
| 5 | Energy accounting on Veil totals: show that DT and feeder loss detection still works | new | An experiment measures loss detection with Veil against raw data | open |

### C. Protocol

| # | item | source | gate | status |
|---|---|---|---|---|
| 6 | Crash window and deliberate aborts: retry an aborted round; identify and exclude a meter that keeps aborting rounds | §11 + new | E4's crash test publishes every round; a written argument covers the retry and the exclusion | open |
| 7 | Heavy dropout: choose k per feeder from its dropout; derive the privacy bound for the random circulant graph | §11 | Rounds publish at the worst CEEW dropout with the bound met | open |
| 8 | Machine-checked proof of the round in Tamarin or ProVerif | new | The privacy property in docs/rounds.md is proved by the tool | open |

### D. Cryptography

| # | item | source | gate | status |
|---|---|---|---|---|
| 9 | Fast crypto: WebCrypto X25519 and Ed25519 in the browser, WASM elsewhere; replace the hand-written range proofs in `src/pedersen.ts` with an audited Bulletproofs library | §11 + new | Setup and verified mode re-measured; no hand-written zero-knowledge proofs remain | open |
| 10 | Meter-side library in C or no-std Rust, checked against the TypeScript core with shared test vectors; code size and RAM from the toolchain; runs under an emulated Cortex-M | new | A meter maker could take it into firmware | open |

### E. Privacy

| # | item | source | gate | status |
|---|---|---|---|---|
| 11 | Stronger attacks: more appliances, a learned disaggregation attacker, real multi-home data, the membership-change attack, and small DT groups at coarse resolution | §11 | Each minimum group size holds against the strongest attacker built | open |

### F. System

| # | item | source | gate | status |
|---|---|---|---|---|
| 12 | Networked protocol over MQTT, with latency, loss and reconnects | new | Hundreds of separate meter processes publish exact totals | open |
| 13 | Crash-safe state: the coordinator resumes after a restart without breaking one view per round | new | A kill-and-restart test passes | open |
| 14 | Many groups: a sharded coordinator and a load test at discom scale | new | Measured throughput at a stated number of meters | open |
| 15 | Key management: device certificates, enrolment, revocation, meter replacement, PKCS#7 key files, a slot for secure hardware | §11 | A meter is replaced and a key revoked mid-epoch in a test | open |
| 16 | Networked ledger on Hyperledger Fabric, and who runs the validators (discom, regulator, AMISP) | §11 | Validators run as separate nodes | open |

### G. Integration

| # | item | source | gate | status |
|---|---|---|---|---|
| 17 | IS 15959 (DLMS/COSEM) on the meter side; IEC 61968-9 over REST/JSON towards the MDM; an operator dashboard | new | A standard HES and MDM could consume Veil's output | open |
| 18 | Consumer access: an end-to-end encrypted channel from meter to the consumer's app, so the home sees its own interval data and the operator does not | new | Meets the consumer-data rule without reopening the leak | open |
| 19 | Operations: containers, configuration, logs, metrics, alerts and a runbook | new | Someone other than the author can run it | open |

### H. Documentation and close-out

| # | item | source | gate | status |
|---|---|---|---|---|
| 20 | Threat model and governance, including what Veil does not hide: billing, prepaid balances, time-of-day energy per home, and who is online | new | Every party's trust and failure case is written down | open |
| 21 | Compliance mapping: DPDP Act and Rules, CEA cyber-security regulations [R6], CERT-In; a DPIA template | new | A discom's compliance team can check it item by item | open |
| 22 | Licence | new | A LICENSE file | open |
| 23 | Re-run every experiment, update REPORT.md, pass the trace gate | §11 | Same standard as Phase 8 | open |

Order: 1, 2, then 3 to 5, which decide the round's shape, then 6 to 8, 9 and 10, 11, 12 to 19, and 20 to 23.

## Outside this repository

Code cannot settle these: an independent security audit, peer review of docs/rounds.md, BIS and STQC certification, legal review, a pilot on a discom feeder, and timings on meter-class hardware.

## Sources

Tags E2 and params refer to REPORT.md's experiments; S14 to docs/sources.md. R4 was read in full; the others come from search-result summaries on 2026-10-04 and should be re-read before any figure from them enters REPORT.md.

- [R1] CEA, Report on status of metering of feeders, DTs and consumers as on 31 March 2024. https://cea.nic.in/wp-content/uploads/notification/2024/09/Report_on_Metering_status_of_Feeders_DTs_and_Consumers__as_on_31st_March_2024.pdf Figures as reported by SolarQuarter (https://solarquarter.com/2024/09/04/cea-report-on-metering-infrastructure-status-and-its-role-in-strengthening-indias-power-distribution/): 34.18 crore consumers, 1.51 crore DTs. The ratio is computed here and counts every consumer category.
- [R2] CSTEP, "Going Smart With Energy Audit". https://cstep.medium.com/going-smart-with-energy-audit-2b3085700d98
- [R3] Silicon Labs and Wirepas, India AMI case study (https://www.silabs.com/applications/case-studies/indias-ami-goals-met-with-rf-mesh-technology-from-wirepas-and-silicon-labs), and KORE Wireless, network requirements for utility IoT (https://www.korewireless.com/blog/smart-meter-connectivity-network-requirements-for-utility-iot/): readings every 15 minutes, 96 a day, over RF mesh or cellular.
- [R4] CEA, Guidelines for Standardization and Interoperability in AMI Systems, January 2025: sections 1, 5.6, 6 and 7. https://cea.nic.in/wp-content/uploads/dp_t/2025/01/AMI_Interoperability_Report__Final-3.pdf
- [R5] Electricity (Rights of Consumers) Amendment Rules, 2023 (PIB release). https://www.pib.gov.in/PressReleaseIframePage.aspx?PRID=1934673
- [R6] CEA, Draft Cyber Security in Power Sector Regulations, 2024. https://cea.nic.in/regulations/draft-central-electricity-authority-cyber-security-in-power-sector-regulations-2024/
