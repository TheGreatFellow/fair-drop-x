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
| **2. Auction drop on Uniswap v4** | Multi-unit sealed-bid (uniform-price Vickrey) drop with a 定価 fan raffle, built as a v4 hook (§8.2) | Uniswap — Best Stack Contribution ($6,000, 3 places) | Sun early morning |

**Phase 1 is the submission.** Phase 2 is started only once the contract, the World ID backend
and the frontend all work end to end, and only if that happens with hours to spare. A polished
Phase 1 beats a broken Phase 2 — one finished integration beats two half-built ones.

**Phase 1 is done** (2026-09-26 01:43: contract, World ID backend and drop page working end to end
on Sepolia, live at fair-drop-sable.vercel.app). Phase 2 is the auction drop (§8.2), decided
2026-09-26 03:00: it replaces the curve as the headline mechanism, because it measures the market
price instead of guessing it with a slope. It is still **additive**: a new contract on a feature
branch; `Drop.sol` and the curve demo stay deployed and untouched as the fallback. If the auction
isn't deployed and passing its tests two hours before submission, submit Phase 1.

## 5. Explicitly out of scope (decided, do not build)

- Demand-triggered production runs (items are fixed limited editions).
- Same-human-only redemption, transfer locks, claim restrictions.
- ~~Uniform clearing-price auction.~~ **Reopened 2026-09-26** as the Phase 2 mechanism (§8.2). Why the
  original objection no longer holds: (1) World ID gives every bidder unit demand, which removes the
  classic flaw of uniform-price auctions — large buyers shading bids ("demand reduction") — and makes
  the uniform (highest-losing-bid) price the multi-unit Vickrey price, where bidding your true value
  is optimal; (2) a reserve of 定価 means fans pay the normal price whenever demand is low; (3) a
  定価 fan raffle keeps access for fans who can't outbid the richest buyers.
- Uniswap v4 custom-curve hook **for the main drop** — i.e. replacing `price(i)` in `Drop.sol` with an
  AMM curve. (Phase 2's auction drop is a separate v4 hook contract — see §8.)
- **ENSv2 subnames (descoped 2026-09-25).** Giving each unit a subname like `042.drop.maker.eth`
  is decoration: the NFT stays the source of truth and nothing reads the name, which fails ENS's
  "central, not cosmetic" bar. The one genuinely non-cosmetic angle is that this drop's units
  churn — sell-back burns a unit, so names must be revoked and edition numbers retired, which is
  real Permissioned Registry lifecycle work most projects never exercise. Not worth the risk of a
  Sepolia beta API against a $6,000 prize split three ways while Phase 1 is unfinished. The
  `_afterMint` / `_beforeBurn` hooks are already deployed, so this stays cheap to revisit.
- **Pay-as-bid auctions** (each winner pays their own bid). Fans would have to guess others' bids and
  shade their own; the uniform price in §8.2 makes honest bidding optimal instead.

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

## 8. Phase 2 — Auction drop on Uniswap v4

### 8.1 Why an auction replaces the curve

Scalping exists because of a gap: 定価 sits below the market price, and the scalper pockets the
difference. The Phase 1 curve captures that gap for the maker by *guessing* the market price with a
slope the maker picks. A sealed-bid auction captures it by *measuring* the market price directly —
same thesis, better instrument. The story becomes: fan units at 定価 (the culture) → the rest priced
by sealed bids (the gap goes to the maker) → resale has no edge, because winners already paid the
market price → one per human throughout.

### 8.2 Mechanism

One sealed-bid round for a drop of N units, of which X are fan units.

1. **Bid.** Each verified human submits one sealed bid — a commitment `hash(bid, secret, bidder)`
   plus a deposit ≥ bid, so the deposit hides the bid. One bid per World ID nullifier. The secret is
   random and kept in the browser; losing it means the bid can't be revealed (accepted for the
   hackathon).
2. **Close bidding** — from the admin console, not a timer, so the demo controls the pace. Closing
   early gives the maker no edge: bids are sealed.
3. **Reveal.** Bidders open their bids. The reveal phase stays open a **minimum time** (default 2
   minutes) before the admin may settle, so bidders can't be cut off.
4. **Settle.**
   - **Fan raffle first:** X units at 定価, drawn at random among revealed bids ≥ 定価.
   - **Then the auction:** the remaining N − X units go to the highest remaining bids. Every winner
     pays the same price — the highest losing bid, or 定価 if there are fewer bids than units.
   - Raffle-first is deliberate: the bid doesn't affect raffle odds, so bidding your true value stays
     optimal. Raffling among auction losers instead would reward bidding low on purpose.
   - Unrevealed bids forfeit their deposit.
5. **Claim and withdraw.** Pull-based: losers get their deposit back, winners get their unit plus
   deposit minus price. The maker withdraws everything the sale raised as soon as it settles.
6. **No sell-back** (removed 2026-09-26, the builder's call after testing). In the curve drop,
   sell-back is how the drop outcompetes resale: a returned unit goes back on sale cheaper. In the
   auction it has nothing to do: winners paid the market price, so there is no resale edge, and in
   a single round a returned unit is just burned. It only locked the maker's proceeds until the
   sale closed. The only units worth flipping are fan units, bought at 定価 — a deliberate gift to
   fans, and one a 95%-of-定価 buy-back wouldn't compete with anyway. Hosted resale on the pool
   (§8.6) is the successor. `Drop.sol` keeps its sell-back.

Knobs: N, X, 定価 (reserve), optional price cap (if demand at the cap exceeds the remaining
units, those at the cap are raffled).

### 8.3 Why World ID is central here

With one bid per human, every bidder wants at most one unit. For that case the uniform
highest-losing-bid price *is* the multi-unit Vickrey price, and bidding your true value is the best
strategy. The known weakness of uniform-price auctions — a buyer wanting many units bids low to pull
the price down on all of them — cannot happen. **World ID is what makes a multi-unit auction
honest.**

### 8.4 How it lives on Uniswap v4

- **A bid is a swap.** Bidders swap ETH into the auction pool (Universal Router → PoolManager). The
  hook's `beforeSwap` takes the whole input and returns nothing yet — OpenZeppelin's `BaseAsyncSwap`
  pattern — recording the deposit and the commitment passed in `hookData`, and checking the World ID
  voucher there.
- Permissions: `beforeSwap` with return delta (async bid), `beforeAddLiquidity` (no outside
  liquidity), `beforeInitialize` (bound to one pool). Hook address mined with HookMiner.
- Settlement and refunds run through the PoolManager's `unlockCallback` (deposits are held as
  ERC-6909 claims); the MEV-auction hook is the reference for escrow + pull refunds.
- Because bids are swaps, the Universal Router can route any token → ETH → bid in one transaction:
  pay-with-any-token comes for free, subject to Sepolia liquidity.
- Sepolia: PoolManager `0xE03A1074c86CFeDd5C142C4F04F1a1536e203543`, Universal Router
  `0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b` (both verified to have code).

### 8.5 Build rules

- Branch `feat/auction-hook` from `main`; merged only once it passes its tests. Vercel builds only
  `main` to production; branch pushes get preview URLs without secrets.
- Reuse the World ID backend and voucher signing from Phase 1.
- Tests required before it counts as working: uniform price = highest losing bid; fewer bids than
  units → everyone pays 定価; raffle only among bids ≥ 定価 and doesn't change auction outcomes;
  one bid per nullifier; unrevealed deposits forfeit; admin can't settle before the minimum reveal
  time; ordinary swaps blocked; refunds exact; every wei accounted for (bidders' refunds + the
  maker's proceeds = all deposits).
- Demo with multiple bidders: pending World's answer on multiple simulator identities (asked
  2026-09-26 morning); fallback is test mode for the extra bidders.

### 8.6 Future enhancements (not for this hackathon)

- **World ID validation hook for Uniswap's CCA** — CCA's official `IValidationHook` slot gating bids
  to one per human.
  **TODO (candidate for this hackathon, on hold 2026-09-26 until World clarifies the staging
  setup):** an add-on, not a rewrite. CCA is public, continuous and fungible, so the sealed drop
  can't move over, but the World ID gate can. `validate(maxPrice, amount, owner, sender, hookData)`
  checks our voucher in hookData, allows one bid per nullifier, and caps each bid at one unit's worth
  (unit demand, §8.3). CCA passes `owner`, so no `tx.origin`. The CCA factory v2.1.0 is on Sepolia at
  `0x000000001F26a0044BaA66024e7b6599c61963F8`. Scope, about 2h: the hook, fork tests against the real
  CCA, a live Sepolia instance, the backend voucher target, a README section; no frontend. Build it
  after the merge and README.
- **Resale on Uniswap after settlement** — the hook opens the pool as the resale market at the
  clearing price, with hook fees paying the maker on every resale: "we don't ban resale, we host it."
- Route A (Trading API pay-with-any-token) as a standalone feature, if the Universal Router path
  above doesn't cover it.

Research still to do: tie-breaking at the clearing price; how CCA's design avoids timing games; how
fans reacted to real ticketing auctions and dynamic pricing.

## 9. Demo script (4 min + 3 min Q&A)

For the demo, deploy with a small `flatUnits` (e.g. 2–3) so the curve kicks in live.
1. Problem in 20s: limited merch → sells out → Mercari at 10–20x.
2. Judges verify with World ID and place sealed bids; nobody can see the amounts.
3. Same judge tries to bid again → **rejected** (World's required alternative path).
4. Admin closes bidding → judges reveal → settle: fan units raffled at 定価, the rest clear at one
   price — the highest losing bid — shown on screen.
5. Close: the gap scalpers used to take is on screen, and the maker withdraws it.

Fallback if the auction isn't ready: the Phase 1 curve demo (fan price → demand pricing → rejection
→ sell-back), which is live and tested.

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
2. **Phase 2:** auction drop hook on `feat/auction-hook` (§8) → tests → deploy to Sepolia →
   auction tab in the web app → merge. FEEDBACK.md + Uniswap feedback form. Commit.
4. Final: README, demo video, AI attribution, submit with buffer before 09:00 JST Sunday.
