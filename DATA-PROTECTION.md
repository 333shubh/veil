# Data-protection note

A short note for a distribution utility (discom) in India considering Veil. It describes what data Veil keeps from the operator and what it does not. It is not legal advice: the statutory points below are paraphrased from secondary summaries and must be checked against the Act and the Rules by counsel.

## Why it matters now

India's smart-meter rollout under RDSS has 20.33 crore smart meters sanctioned, 19.79 crore of them consumer meters [S9]. A consumer meter's fine-grained readings show when a household wakes, cooks, runs its water pump or goes away: in this repository's experiment, a detector finds one home's pump switching on from its raw readings with AUC 0.990 [E5].

The Digital Personal Data Protection Act, 2023 (No. 22 of 2023) governs personal data of identifiable individuals [S6], and its Rules were notified in November 2025, with most obligations commencing after 18 months [S7]. A discom that decides why and how meter data is processed would be a data fiduciary for it. Failing to take reasonable security safeguards against a breach (section 8(5)) can draw a penalty of up to ₹250 crore [S8].

## What Veil changes

| data | without Veil | with Veil |
|---|---|---|
| High-frequency readings of one home | Sent in the clear to the head-end | Never leaves the meter unmasked; the operator gets a masked value that looks random |
| Group total | Computed by the operator from individual readings | Computed exactly from masked values; published only for groups of at least 200 homes [params] |
| Which meters reported in a round | Known | Still known: the active set is signed and recorded |
| Billing register (energy per billing interval) | Per home | Still per home, over a separate, coarser channel |
| Keys | Long-lived | Fresh per epoch; old epoch keys are erased and the report key is ratcheted |

The operator's view of a masked home is indistinguishable from chance in the test that was run: 54.0% ± 5.6 classification accuracy between two reading vectors with the same total, against 100.0% ± 5.7 on raw readings [indist]. The pump detector falls to AUC 0.532 on a 200-home total [E5].

This is data minimisation: the high-frequency stream is reduced to what grid operations need, a feeder or transformer total. It supports the Act's security and purpose-limitation obligations; it does not remove them.

## What remains personal data

- **The billing channel.** Bills and time-of-day tariffs need each consumer's energy per billing interval. That register is personal data and needs the usual notice, purpose limitation, security, retention limits and erasure.
- **Meter identities and participation.** The roster, the device keys and the set of meters reporting each round identify households and show when a meter is online. Power cuts and faults are visible.
- **Masked reports.** Each masked report is tied to a meter ID. Whether such data is personal data under the Act is a legal question, and the design does not depend on the answer: treat masked reports as personal data and protect them.
- **Small groups and membership changes.** A total over few homes, or the change in a total when one home joins or leaves, can expose that home. Veil suppresses totals below 200 homes and changes membership only at epoch boundaries [params] [E5]. Rural feeders with fewer homes need a different grouping, not a smaller minimum.
- **Per-meter functions.** Outage, tamper and theft detection and per-consumer demand response need individual data. Send these as low-rate meter-side alarm events with their own notice and purpose, not as a back door to the high-frequency stream.

## Recommendations for a discom

- **Assess before deploying.** Run a data-protection impact assessment covering the billing channel, the alarm channel, the roster and the ledger, whether or not the Act requires one of the discom.
- **Separate the channels.** Keep the Veil stream, the billing register and alarms on separate channels with separate purposes, access controls and retention periods.
- **Keep the minimum group size.** Do not publish or store totals of fewer than 200 homes [params]. Revisit the number if new attacks on group totals appear; it rests on one attack on simulated homes [E5].
- **Protect keys.** Store device keys in secure hardware, erase epoch keys at rollover, and record key handling in the security-safeguards documentation.
- **Keep the ledger minimal.** It needs roster hashes, co-signed active-set hashes, totals and Merkle roots, not readings. Anyone with access sees totals and participation, so limit who can read it.
- **Plan for breach notification.** A leak of billing data or device keys is a personal-data breach under the Act and the Rules, and must be reported to the Data Protection Board and to affected consumers [S6] [S7].
- **Get legal review** of the classification of masked reports, of the lawful basis for billing and alarms, and of retention periods, before relying on this note.
