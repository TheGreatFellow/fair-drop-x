# SPEC — fair-drop (working name)

ETHGlobal Tokyo 2026 hackathon project. Solo builder, 36 hours.
**Submission deadline: Sunday Sep 27, 2026, 09:00 JST.**

## 1. Problem

Japan sells a lot of limited-edition / special-edition merch (anime goods, artist goods, trading cards, collabs). Makers deliberately price it low and allocate by first-come-first-served (先着) or lottery (抽選). It sells out instantly, then trades on Mercari at 10–20x. The markup goes to resellers (転売ヤー), not the maker, and bots/multi-accounts hoard stock.

## 2. Solution (one line)

A drop platform where the first X units of a limited-edition item sell at the normal fixed price, after which the price rises along a curve as units sell. Each verified human can buy only one, and anyone holding a unit can sell it back to the maker at the current price minus a small spread.

Pitch: *"Early fans pay the normal price. After that, demand sets the price — and the markup goes to the maker, not to scalpers. We don't ban resale; we outcompete it."*

## 3. Core rules

1. **One per human.** World ID (IDKit) verification; the nullifier blocks a second purchase for the same drop. A human who sells back can NOT buy again (prevents cycling).
2. **Fixed fan price first.** The first `flatUnits` (X) units all sell at `basePrice`, the normal 定価. This keeps the fixed-price culture fans expect.
3. **Curve after that.** From unit X+1 onward, price rises with each sale. The last units are priced steeply so the curve rarely fully sells out; while the curve has units, nobody rationally pays more than the curve price elsewhere.
4. **Sell-back at current price minus spread.** Burns the unit, lowers `sold`, lowers the price for the next buyer. Spread (default 5%) is below Mercari's ~10% seller fee plus shipping hassle, so selling back beats reselling.

Transfers are NOT restricted. Units are normal transferable tokens.

## 4. Phases

Each phase must be fully working, committed and demo-able before starting the next.

| Phase | Scope | Prize target | Target done by |
|---|---|---|---|
| **1. Core + World** | Contract (flat price → curve, buy, sell-back, withdraw), World ID verification backend, drop page | World — Best Use of IDKit ($7,500) | Sat afternoon |
| **2. ENS** | Each unit is also an ENSv2 subname | ENS — Best Use of ENSv2 ($6,000, 3 places) | Sat night |
| **3. Uniswap (if time permits)** | Pay with any token via Uniswap | Uniswap — Best Stack Contribution ($6,000, 3 places) | Sun early morning, or skip |

If Phase 2 isn't working by Saturday night, stop, polish Phase 1 and submit. A polished Phase 1 beats a broken Phase 2.

## 5. Explicitly out of scope (decided, do not build)

- Demand-triggered production runs (items are fixed limited editions).
- Same-human-only redemption, transfer locks, claim restrictions.
- Uniform clearing-price auction.
- Uniswap v4 custom-curve hook (too risky solo; Phase 3 uses the simpler integration).

---

## 6. Phase 1 — Core + World

### 6.1 Smart contract

Foundry project, Solidity. Target chain: **Sepolia** (ENSv2 beta is on Sepolia, so Phase 2 fits without a chain change). Payment in **native ETH** for Phase 1 (no approve step).

#### Config (set at deploy / drop creation)
- `maker` — receives proceeds
- `supply` — max units (N)
- `basePrice` — the normal fixed price
- `flatUnits` — X, number of units sold at `basePrice`
- `slope` — price increase per unit in the curve segment
- `steepStart` — index where the steep final segment begins (default: 90% of N)
- `steepSlope` — per-unit increase in the steep segment
- `spreadBps` — sell-back spread (default 500 = 5%)
- `saleEnd` — timestamp; after this, buying and sell-back close
- `verifier` — address of the backend key that signs purchase vouchers
- `dropId` / World ID action scope

Constraint: `0 < flatUnits < steepStart <= supply`.

#### Price
`price(i)` = price of the unit at index `i` (0-based, i.e. the (i+1)th sale):
- `i < flatUnits`: `basePrice`
- `flatUnits <= i < steepStart`: `basePrice + slope * (i - flatUnits + 1)`
- `i >= steepStart`: `price(steepStart - 1) + steepSlope * (i - steepStart + 1)`

Next buy costs `price(sold)`. Sell-back pays `price(sold - 1) * (10000 - spreadBps) / 10000`.
Expose view functions for current buy price, current sell-back price, units left, whether the flat phase is still active, and the full curve for charting.

#### Functions
- `buy(Voucher v, bytes sig)` payable
  - `block.timestamp < saleEnd`, `sold < supply`
  - verify EIP-712 signature by `verifier` over `{dropId, buyer, nullifierHash, deadline}`
  - `v.buyer == msg.sender`, `deadline` not passed, `nullifierUsed[nullifierHash] == false`
  - `msg.value >= price(sold)`; refund excess
  - mark nullifier used, mint unit to buyer, `sold++`
- `sellBack(uint256 tokenId)`
  - sale open, caller owns token
  - burn, `sold--`, pay `price(sold) * (1 - spread)` (computed after decrement = the top unit's price)
- `withdraw()` — maker only
  - while sale open: withdrawable = `balance - liability`, where `liability = (1 - spread) * Σ price(i) for i < sold` (cost of buying back every outstanding unit)
  - after `saleEnd`: everything
- `redeem(uint256 tokenId)` — optional, after `saleEnd`: burn + emit `Redeemed(tokenId, owner)` for physical fulfilment

Design the minting so Phase 2 can hook in without a rewrite (e.g. an internal `_afterMint(tokenId, buyer)` / `_beforeBurn(tokenId)` that Phase 2 overrides or extends).

#### Invariants (must have tests, incl. fuzz)
- **Solvency:** after any sequence of buys, sell-backs, and withdrawals, `balance >= liability`. Every sell-back is always payable.
- **Maker never loses:** after any sequence of buys and sell-backs, `total received - total paid out >= Σ price(i) for i < sold` (see §6.4). In particular maker cash `>= sold * basePrice`.
- One purchase per nullifier, ever, per drop.
- `price(i) == basePrice` for all `i < flatUnits`; strictly increasing for `i >= flatUnits - 1`.
- Sell-back payout < what the latest buyer paid.
- Rounding: sell-back payout always rounds **down** (in the contract's favour).
- `spreadBps > 0` enforced at deploy (recommended 300–1000).

#### Required cascade tests
- 80% sold → 1, 10, 30, 60 sell-backs in a row → assert maker-never-loses and solvency after each.
- 80% sold → **everyone** sells back → contract still pays every seller; maker keeps only spread income, never negative.
- Random churn fuzz: random interleaving of buys and sell-backs → both invariants hold at every step.

### 6.2 Backend (World ID verification)

Keep this simple: users verify with the **World App**. Use the standard IDKit flow from World's docs; don't over-engineer.
- The user taps "Verify with World ID", scans/approves in World App, the app returns a proof.
- Backend verifies the proof **server-side** (World requires this; never trust the client response).
- Action scoped per drop; signal = buyer wallet address.
- On valid proof: store the nullifier, return an EIP-712 voucher signed by the verifier key. The contract enforces the nullifier onchain too.
- Keep the verifier private key server-side only.
- For the submission, one or two sentences on why World ID is the right check: "one unit per real person" is exactly what stops bots and multi-account hoarding.

### 6.3 Frontend

Next.js + wagmi/viem. One drop page:
- item card, current price, units left
- phase badge: **"Fan price — X of Y left at ¥___"** during the flat phase, then **"Demand pricing"**
- **live price chart**: flat line for the first X units, then the rising curve, with a marker at the current position
- a static comparison line: "typical Mercari resale price" (the visual point of the project)
- Verify with World ID → Buy
- My units → Sell back (shows payout) / Redeem (after close)
- clear rejection states: "already purchased" (same human again), "verification failed/cancelled"

Demo friction note: judges buying from their phones need testnet ETH. Plan for pre-funded demo wallets or teammates/volunteers; record a backup video.

### 6.4 Maker economics — why sell-back cascades can't cause a loss

**Key fact:** price depends only on position on the curve. Every time `sold` goes from `j` to `j+1`, the contract receives `price(j)`. Every time it goes back from `j+1` to `j`, it pays out `(1 - spread) * price(j)`, which is **less than what was received for that same position**. So every buy-then-sell-back at any position leaves the maker `spread * price(j)` richer, however many times it happens and in whatever order.

Result, for any history of buys and sell-backs:

```
maker cash = Σ price(i) for units still sold (i < sold)
           + spread × (sum of prices of every sell-back ever made)
           ≥ sold × basePrice
```

The maker's cash never goes negative, and each unit still sold is worth at least its full curve price to the maker.

**Worked example** (simulated): N = 100, basePrice ¥3,000, first 20 flat, +¥150/unit to unit 90, then +¥1,500/unit, spread 5%. 80 units sold, then a chain of sell-backs, each at the updated lower price:

| Sell-backs in a row | Units still sold | Maker cash | = revenue of units still sold | + spread earned |
|---|---|---|---|---|
| 0 | 80 | ¥514,500 | ¥514,500 | ¥0 |
| 10 | 70 | ¥406,912 | ¥401,250 | ¥5,662 |
| 30 | 50 | ¥234,488 | ¥219,750 | ¥14,738 |
| 60 | 20 | ¥82,725 | ¥60,000 | ¥22,725 |
| 80 (everyone) | 0 | ¥25,725 | ¥0 | ¥25,725 |

10,000 random buy/sell-back sequences: maker cash was always at least `units still sold × basePrice` (never below).

**What sell-backs *can* do:**
- **Reduce the maker's upside.** A cascade means fewer units sold at high prices. That's lost *potential* revenue, not a loss.
- **Leave unsold stock.** Returned units go back into the drop and can be bought again. Items are only handed over at redemption after `saleEnd`, so a sold-back unit never left the maker's warehouse.
- **Let early holders profit.** A fan who bought at ¥3,000 can sell back at a higher curve price. That profit is paid by later buyers' money, not the maker's, and the maker still keeps the spread.

**Maker config guidance** (show in the drop-creation UI or README):
- Set `basePrice` ≥ the per-unit production cost. Then every unit that ends up sold is profitable, and the only real risk is unsold stock, the same as any drop.
- The spread is the maker's guaranteed income from churn. 5% is below Mercari's ~10% fee, so sellers still prefer selling back.

**Withdrawals keep this safe:** while the sale is open, the maker can only withdraw what's above the full buy-back liability (§6.1 `withdraw`), so a cascade can never find the contract short.

### 6.5 World prize requirements (Best Use of IDKit)
- integrate IDKit in a functioning app with server-side/onchain verification
- explain the trust moment and why the chosen credential is the minimum sufficient assurance
- demo one success + one meaningful alternative path (rejection)
- include an **integration debrief**: time to first success, friction, missing capability/docs, the single most impactful improvement

---

## 7. Phase 2 — ENS integration

Each unit is also an ENSv2 subname on Sepolia, e.g. `042.drop.maker.eth`.
- Buy → mint subname to the buyer (via the drop's own subname registry under the maker's name).
- Sell-back → contract revokes the subname.
- Expiry set to the redemption deadline.
- Transferable (consistent with rule: transfers not restricted).
- Optional: text records on each subname (item, edition number, price paid).

ENS requirements: ENSv2 features must be central, not cosmetic; functional demo with no hard-coded values; live demo link and open-source code in the submission.
Check the ENSv2 docs (Permissioned Registry, Permissioned Resolver, Enhanced Access Control) — it's a new beta; don't rely on memory. Attend ENS workshop (Fri 15:00, 5F) if possible.

## 8. Phase 3 — Uniswap integration (only if time permits)

**Pay with any token:** buyers holding another token get it swapped to the drop's payment currency via the Uniswap Trading API, then `buy()` runs.
Requirements: public repo, **`FEEDBACK.md`**, completed Uniswap Developer Feedback Form linking to it, README pointing to the exact contracts/lines of the integration.
Uniswap workshop: Fri 16:30, 5F. Ask whether this counts as a meaningful integration.

---

## 9. Demo script (4 min + 3 min Q&A)

For the demo, deploy with a small `flatUnits` (e.g. 2–3) so the curve kicks in live.
1. Problem in 20s: limited merch → sells out → Mercari at 10–20x.
2. Judge verifies with World ID and buys at the fan price.
3. Fan-price units run out → badge switches to "Demand pricing"; next judge buys and the price ticks up on the chart.
4. First judge tries to buy again → **rejected** (World's required alternative path).
5. Someone sells back → price drops, payout shown vs. Mercari fee.
6. (Phase 2) Show the buyer's `042.drop.maker.eth` name; show it revoked after sell-back.
7. Close: curve vs. Mercari line — the gap is the money that now goes to the maker.

## 10. ETHGlobal rules to respect
- Start from scratch (Classic track). No prior project code.
- **Commit early and often.** Large single commits may be disqualified.
- **AI attribution:** document where AI tools were used; include spec files, prompts and planning artifacts (this file counts). Keep prompts/notes in `docs/ai/`.
- Up to 3 partner prizes.

## 11. Q&A prep
- **"Isn't this Unisocks?"** Unisocks (Uniswap, 2019) proved curve pricing for merch but was open to everyone from the first unit, so it became a speculative asset (500 socks, only 185 ever redeemed). We keep a fixed fan price for the first units, add one-per-human, and position it as an anti-scalper tool for real fans.
- **"Isn't dynamic pricing hated?"** (Coca-Cola's 1999 temperature-based vending pricing, reportedly tested in Japan, caused backlash.) Early fans pay the normal fixed price; only demand beyond that pays more — and today the alternative is paying a scalper 10–20x.
- **"Can't early buyers still resell on Mercari?"** Yes — physical resale can't be prevented by any system. We remove bot hoarding (one per human), cap the markup (curve is the best place to buy), and give sellers a better exit than Mercari.
- **"How do physical returns work?"** Returned items are inspected by the maker before restocking; in production, an NFC authenticity tag makes the check instant.

## 12. Build order
1. **Phase 1:** contract + tests (flat price → curve, buy with voucher, sell-back, withdraw, solvency + maker-never-loses fuzz, cascade tests) → deploy to Sepolia → IDKit backend + voucher → frontend → World debrief. Commit.
2. **Phase 2:** ENSv2 subnames on buy / revoke on sell-back → update demo. Commit.
3. **Phase 3 (if time):** Uniswap pay-with-any-token + FEEDBACK.md. Commit.
4. Final: README, demo video, AI attribution, submit with buffer before 09:00 JST Sunday.
