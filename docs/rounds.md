# The Veil round and its agreement check

This note states what a Veil round sends, the rules an honest meter follows, and why those rules keep a meter's reading hidden from a malicious coordinator unless at least t of its neighbours are corrupted. It is a security argument, not a machine-checked proof. It also records a flaw in the Phase 7 round that the agreement check fixes, and why the fix costs dropout tolerance.

Notation: meter i has k neighbours N(i) in the epoch's graph; t > k/2 is the threshold; m_ij(t) is the round mask i shares with neighbour j, s_ij = +1 if i < j and -1 otherwise; v_i(t) is i's round self-mask, the first 8 bytes of its 32-byte round secret; all sums are mod 2^64.

## 1. The round

| step | who | sends |
|---|---|---|
| report | every meter | y_i = x_i + v_i + sum over N(i) of s_ij m_ij, with a MAC under its report key |
| close | coordinator | the active set U: meters with an authentic report |
| confirm | each meter in U | its co-signature on U and its contribution; a *correction* c_i, the sum of s_ij m_ij over neighbours outside U; if at least t of its neighbours are in U, t-of-n shares of its round secret, sealed to those neighbours; a MAC of U's hash to each neighbour in U |
| collect | coordinator | the final set F: meters that dealt shares, pruned until each member has at least t neighbours in F; each meter's neighbours' confirmations |
| check | each confirmed meter | it checks that every confirmation it received names the same U, keeps the shares dealt to it, and fixes F as its **only** view of the round. A meter in F sends each neighbour in U a MAC over (sender, receiver, U, F). If it has neighbours in U \ F, it signs its *removal* e_i, the sum of s_ij m_ij over them, seals it under a fresh key, and deals t-of-n shares of that key to its neighbours in F |
| release | each meter in F | if at least t of its F neighbours sent a MAC over the same (U, F): its round secret and its signed removal |
| unmask | only if a meter in F went silent | its neighbours' shares of its round secret; and, from neighbours that agreed with its view, shares of its escrow key |
| recover | coordinator | sum over F of (y_i - v_i - c_i - e_i) |

Masks between two members of F cancel in the sum; the correction removes masks with meters outside U; the removal removes masks with meters in U but outside F.

## 2. What an honest meter never does

1. **One view per round.** It accepts one U (at confirm) and one F (at check), and uses them for everything after.
2. **Deal after U.** It deals self-mask shares only to neighbours in its U, and only at confirm.
3. **Remove only after agreement.** Its removal leaves it only (a) in its own release, after t F neighbours have MAC'd the same (U, F), or (b) through its escrow key, whose shares are passed on only by neighbours whose own view of (U, F) matches the MAC it sent them.
4. **Pass on a share only for a member of its F.** It passes on neighbour j's self-mask share only if j is in its F, and never after releasing the mask it shares with j.
5. **Bind MACs to direction.** Every pair MAC names sender and receiver, so a relay cannot reflect a meter's own MAC back to it as its neighbour's.

## 3. The claim

Let i be an honest meter with fewer than t corrupted neighbours. Whatever U and F the coordinator shows each meter, and whatever messages it delays, drops or reorders, it cannot compute x_i. (This assumes, as everywhere in Veil, that ChaCha20 masks are pseudorandom, that the MACs, AEAD and signatures are unforgeable, and that fewer than t Shamir shares reveal nothing.)

To learn x_i, the coordinator needs v_i and every m_ij with an honest neighbour j, since each unreleased m_ij is a fresh pseudorandom term in y_i. Masks with corrupted neighbours it has. Take any honest neighbour j and ask when m_ij is released. It happens in one of three ways: (i) in a correction, by i if j is outside i's U or by j if i is outside j's U; (ii) in i's removal, if j is in i's U but not i's F; (iii) in j's removal, if i is in j's U but not j's F.

**Case A: i never releases, and its escrow key is never rebuilt.** Then i's removal never leaves it, and v_i can only come from shares. i dealt them only to neighbours in its own U (rule 2). An honest holder j passes one on only if i is in j's F (rule 4). Then i is in j's U, so j's correction does not hold m_ij. j is in i's U, since i dealt to it, so i's correction does not hold m_ij either. Since F is a subset of U, j's removal does not cover i. So m_ij stays hidden unless i's removal releases it, which in this case it cannot. Every honest holder that gives up a share therefore keeps one mask secret. The coordinator needs t shares, and at most t - 1 can come from corrupted holders. So it needs at least one honest holder, and x_i stays hidden.

**Case B: i releases, or its escrow key is rebuilt.** Either way, at least t of i's F neighbours are shown as holding the same view (U, F) as i. For a release, i counted t of their MACs over its view. For an escrow key, t holders each passed on a share only after finding i's MAC to them equal to their own view. At most t - 1 of them are corrupted, so one, say a, is honest. Then a's single view is i's view, and a is in i's F (a meter in F only counts F neighbours). Also i is in a's F, since a's F is i's F. Going through the three ways: i's correction does not cover a (a is in i's U); a's correction does not cover i (i is in a's U); i's removal does not cover a (a is in i's F); a's removal does not cover i (i is in a's F). So m_ia is never released, and x_i stays hidden.

In both cases the coordinator is short a mask, so the claim holds.

## 4. The fast path is the release

The research spec proposed, as an unproven optimisation, that a meter confirmed in the final set could reveal its own round seed, so shares need rebuilding only for meters that crash. In this round, that is the release step, and Case B covers it. A meter reveals v_i only after t neighbours agreed on its view, and those neighbours would pass on its shares anyway. Revealing v_i therefore gives the coordinator nothing that the share path would not. In exchange, the coordinator stops rebuilding every self-mask from t shares (E3 measures the difference), and meters stop sending shares unless someone went silent (E2).

## 5. The flaw in the Phase 7 round

Phase 7 had no check step. The coordinator announced F with the release request, and a meter in F sent its removal and its neighbours' shares in one message, without comparing F with anyone. That breaks Case B. The coordinator shows victim i an F that excludes all of i's neighbours, so i's removal covers every mask it has. It shows each neighbour the true F, so they pass on i's shares. The coordinator then has y_i, v_i, c_i and e_i, and x_i = y_i - v_i - c_i - e_i. A replay against the Phase 7 code recovered the victim's exact reading with no corrupted meters (experiments/results/final-split-phase7.md). `test/attacks.test.ts` replays every such split against the current code: it fails with 0, 2 or 3 of 6 neighbours corrupted and succeeds only with t = 4.

## 6. Why F is never changed after the check

When a meter in F goes silent before releasing, a tempting repair is to shrink F and ask everyone to check again. That reopens the attack. Suppose i's neighbours agreed on F, and then some of them moved on to a smaller F' that leaves i out. They would remove the masks they share with i under F'. Their stale MACs over F still count toward i's check, and toward the checks of neighbours that stay on F and pass on i's shares. Counting the two disjoint groups of honest neighbours, such an attack needs only 2t - k corrupted neighbours instead of t (12 instead of 33 at k = 54). So the round never re-checks. Instead, a silent member's secret is rebuilt from shares, and its removal comes out of escrow. A round still aborts if a meter that must remove masks goes silent before it checks, since its removal was never escrowed. E4 measures how often that happens.

## 7. The price: dropout tolerance

Each member of F needs t neighbours in F. With t just above k/2, heavy dropout breaks that. Pruning one meter takes a neighbour out of F for each of its neighbours, and the pruning cascades. Under an honest coordinator, the Phase 7 round published at 40% dropout with about half the reporters included. It did so only by skipping a check that, as Section 5 shows, a malicious coordinator can exploit. The current round suppresses such rounds instead. The cure is a larger neighbourhood: t only has to exceed k/2 by enough to meet the privacy bound, so a larger k tolerates more dropout. E4 measures the trade-off at N = 200.

## 8. What this argument does not cover

- It bounds what the coordinator learns from one round. Membership changes between rounds and epochs still leak through the totals, as the report's limitations state.
- It assumes fewer than t of an honest meter's neighbours are corrupted. The probability of that is E7's privacy bound, computed for a graph fixed before corruption.
- Corrupted meters can refuse to answer, making rounds abort. That is denial of service, not a privacy failure.
