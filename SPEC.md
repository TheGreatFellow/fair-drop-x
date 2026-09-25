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
| **2. Uniswap (only if Phase 1 is fully done)** | One of two routes, by time remaining: **A** pay with any token via the Trading API, or **B** Vickrey auction as a v4 hook | Uniswap — Best Stack Contribution ($6,000, 3 places) | Sun early morning, or skip |

**Phase 1 is the submission.** Phase 2 is started only once the contract, the World ID backend
and the frontend all work end to end, and only if that happens with hours to spare. A polished
Phase 1 beats a broken Phase 2 — one finished integration beats two half-built ones.

Phase 2 has two routes to the same prize (§8). Route A is a few hours and shallow; Route B is the
ambitious one and is a **stretch goal only**. Whichever is attempted, it is additive: it must not
modify `Drop.sol` or the Phase 1 demo.

## 5. Explicitly out of scope (decided, do not build)

- Demand-triggered production runs (items are fixed limited editions).
- Same-human-only redemption, transfer locks, claim restrictions.
- Uniform clearing-price auction.
- Uniswap v4 custom-curve hook **for the main drop** — i.e. replacing `price(i)` with an AMM curve.
  Too risky solo, and it would discard the flat fan price. (A v4 hook for a *separate* Vickrey
  auction drop is in scope as a stretch goal — see §8.2.)
- **ENSv2 subnames (descoped 2026-09-25).** Giving each unit a subname like `042.drop.maker.eth`
  is decoration: the NFT stays the source of truth and nothing reads the name, which fails ENS's
  "central, not cosmetic" bar. The one genuinely non-cosmetic angle is that this drop's units
  churn — sell-back burns a unit, so names must be revoked and edition numbers retired, which is
  real Permissioned Registry lifecycle work most projects never exercise. Not worth the risk of a
  Sepolia beta API against a $6,000 prize split three ways while Phase 1 is unfinished. The
  `_afterMint` / `_beforeBurn` hooks are already deployed, so this stays cheap to revisit.
- **Replacing the flat-then-curve mechanism with an auction.** An auction makes fans pay their full
  willingness to pay, which is the scalper outcome this project exists to prevent, and it discards
  the fixed fan price that distinguishes us from Unisocks. A Vickrey auction as an *additional,
  separate* drop type is a stretch goal (§8.2); swapping out the Phase 1 mechanism is not.

---

## 6. Phase 1 — Core + World

### 6.1 Smart contract

Foundry project, Solidity. Target chain: **Sepolia** (the Uniswap Trading API supports chain ID
11155111, so Phase 2 needs no chain change). Payment in **native ETH** for Phase 1 (no approve step).

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

Minting goes through internal `_afterMint(tokenId, buyer)` / `_beforeBurn(tokenId)` hooks so any
later integration attaches without touching `buy` / `sellBack`. These are deployed and empty;
they cost nothing and keep the descoped ENS option open.

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

## 7. ENS — descoped

Dropped on 2026-09-25, before any ENS code was written. Reasoning is in §5. In short: a subname
per unit is a label on a token that already works, and ENS asks for ENSv2 features to be central
rather than cosmetic. The deployed `_afterMint` / `_beforeBurn` hooks keep it reopenable at no
cost, and if it is ever revisited the angle worth building is name revocation on sell-back with
expiry tied to the redemption deadline — lifecycle work, not naming.

## 8. Phase 2 — Uniswap (only if Phase 1 is fully done, with hours to spare)

Two routes to the same prize. Pick by how much time is actually left, and in both cases the work
is **additive**: `Drop.sol`, its 34 tests and the Phase 1 demo must not change.

Shared requirements for either route: public repo, **`FEEDBACK.md`**, completed Uniswap Developer
Feedback Form linking to it, README pointing to the exact contracts/lines of the integration.

### 8.1 Route A — pay with any token (Trading API)

Buyers holding another token get it swapped to the drop's payment currency via the Uniswap Trading
API, then `buy()` runs. A few hours of work, and shallow by the Uniswap team's own assessment.

What was checked at the event (2026-09-25):

- **Sepolia is supported.** Chain ID 11155111 is listed, and the docs say all listed testnets are
  reachable through the API. The warning in `REFERENCES.md` that it might not support Sepolia is
  wrong.
- **The API key is free and self-serve**, rate-limited to 6 requests/second. No approval queue.
- **Liquidity is the open risk, not access.** No Uniswap v3 pool exists on Sepolia for WETH/USDC
  or WETH/UNI at any fee tier. The Trading API also routes v2, v4 and UniswapX, which was not
  checked. Before building anything: get a key and request one quote. If no route comes back, the
  integration demos as a failing swap, which is worse than not integrating at all.
- **The Uniswap team's own read is that this is shallow** — similar to any bonding-curve project.
  Ask how much of "Best Stack Contribution" is scored on `FEEDBACK.md` and the feedback form
  versus integration depth; if feedback carries real weight, a thin integration plus honest
  feedback may still place.

### 8.2 Route B — Vickrey auction as a Uniswap v4 hook (stretch goal)

Suggested by the Uniswap team as the genuinely deep integration. A **second, separate** drop type:
a sealed-bid second-price auction for a limited edition, implemented as a v4 hook, sitting
alongside the flat-then-curve `Drop.sol` rather than replacing it. Same World ID one-per-human
gate, so the anti-scalping thesis still holds — it becomes "one bid per human" instead of
"one purchase per human".

**Sketch.** Bidders commit `keccak256(amount, salt, bidder)` during a bidding window, reveal
after it closes, and the top bidder pays the second-highest price. The hook's job is to make the
pool respect the auction: `beforeSwap` rejects ordinary swaps while bidding or revealing is open,
so the pool cannot be traded around the auction, and settlement happens at the clearing price once
revealed.

**Known hard parts — read before starting, these are why it is a stretch:**

1. **Sealed bids fight the AMM.** v4 swaps are public and atomic; sealed bidding needs bids hidden
   until reveal. Commit–reveal is the only realistic route solo, which means two transactions per
   bidder plus a reveal window, and a bidder who never reveals needs a forfeited deposit.
2. **It cannot be demoed live in 4 minutes.** A bid window plus a reveal window does not fit the
   §9 script. Plan on pre-seeded bids with the reveal shown live, or a recorded segment. Decide
   this *before* building, not after.
3. **Hook plumbing is the real cost, not the auction.** Correct `beforeSwap` return values, hook
   permission flags in the address, and pool initialisation against the Sepolia v4 PoolManager are
   where solo attempts stall. Budget for the plumbing, not the economics.
4. **Keep it away from the reserve.** The Phase 1 solvency invariant (§6.4) holds because the
   reserve only ever moves along `price(i)`. The auction contract must hold its own funds; it must
   never touch `Drop.sol`'s balance.
5. **Abandonment plan.** If the hook is not deployed and passing tests with two hours left before
   submission, drop it and submit Phase 1. Committed-but-broken stretch code in the repo is worse
   than no stretch code, so keep it on a branch until it works.

**Tests required before it counts as working:** highest bidder wins and pays the second price;
a single bidder pays their own bid or a reserve price; unrevealed bids forfeit; no ordinary swap
can execute while the auction is open; one bid per World ID nullifier.

## 9. Demo script (4 min + 3 min Q&A)

For the demo, deploy with a small `flatUnits` (e.g. 2–3) so the curve kicks in live.
1. Problem in 20s: limited merch → sells out → Mercari at 10–20x.
2. Judge verifies with World ID and buys at the fan price.
3. Fan-price units run out → badge switches to "Demand pricing"; next judge buys and the price ticks up on the chart.
4. First judge tries to buy again → **rejected** (World's required alternative path).
5. Someone sells back → price drops, payout shown vs. Mercari fee.
6. Close: curve vs. Mercari line — the gap is the money that now goes to the maker.

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
2. **Phase 2 (only if Phase 1 is fully working with hours to spare):** pick a route by time left.
   Route A — check Sepolia liquidity with one Trading API quote, then pay-with-any-token.
   Route B (stretch) — Vickrey auction v4 hook on a branch, merged only once it passes §8.2's
   tests. Either way: FEEDBACK.md + feedback form. Commit.
4. Final: README, demo video, AI attribution, submit with buffer before 09:00 JST Sunday.
