# Phase 2 plan — auction drop on Uniswap v4

**Tool:** Claude Code (Opus 5.5), 2026-09-26, ~02:30–03:10 JST. Planning only; no code yet.

**Prompts (abridged):** "lets do some proper planning before implementation. i want to have a clear
idea on how it will look like and a basic flow ... checkout [awesome-uniswap-hooks] ... there are a
lot of implementation for auction hooks"; then "can we brainstorm on if we are auctioning all N
units ... when there is high demand for N units of the same product, how can vickreys be extended
for the best possible outcome for everyone"; and "with implementation of vickreys our main problem
... goes into background, how do we fix that?"

## Research (all repos gitingested before use)

- **awesome-uniswap-hooks:** no Vickrey or sealed-bid hook exists; auction entries are Dutch-auction
  launchpads, am-AMM and MEV auctions.
- **OpenZeppelin `uniswap-hooks`:** `BaseAsyncSwap` takes a swap's whole input and settles later —
  the shape that lets a sealed bid *be* a swap. This resolved the apparent mismatch between public,
  instant swaps and secret, delayed bids.
- **MEV-auction hook:** reference for escrow, `unlockCallback` settlement and pull refunds.
- **Uniswap CCA:** Uniswap's own audited auction is uniform-price and hands off to a v4 pool; its
  `IValidationHook` slot is a natural place for a World ID gate (recorded as a future enhancement).
- Sepolia v4 addresses from the official deployments page, checked onchain.

## Decisions

- **All N units, not a single grail item.** A single-item auction is a side attraction; auctioning
  the edition makes the auction the anti-scalper mechanism itself. The curve guessed the market
  price; the auction measures it.
- **Uniform price (highest losing bid) with a 定価 reserve**, reopening SPEC §5. The builder's call,
  on the argument that World ID's unit demand makes the uniform price the truthful multi-unit
  Vickrey price.
- **Fan raffle first, then auction**, so the bid never affects raffle odds and honest bidding stays
  optimal.
- **Admin console closes bidding** instead of timers (builder's call, for demo control), with a
  minimum reveal window so bidders can't be cut off.
- **Random secret kept in the browser**, loss accepted for a hackathon (builder's call).
- **Public RPC endpoint kept** (builder's call); the known failure mode is rate-limiting on the one
  onchain read in `/api/verify`.
- Multi-bidder demo waits on World's answer about simulator identities; test mode is the fallback.
- `Drop.sol` and the curve stay deployed as the fallback demo.
