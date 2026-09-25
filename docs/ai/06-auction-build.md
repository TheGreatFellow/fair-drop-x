# Phase 2 build — AuctionDrop hook, deploy, web page

**Tool:** Claude Code (Opus 5.5), 2026-09-26, ~06:30–07:30 JST, on branch `feat/auction-hook`.

**Prompt:** "go" — build SPEC §8 as planned in `05-auction-plan.md`.

## What was built

- `src/AuctionDrop.sol` — the hook. Inherits OpenZeppelin `BaseAsyncSwap`: a bid is an exact-input
  ETH swap whose whole input the hook keeps as ERC-6909 claims. Voucher, commitment and one-bid-per-
  nullifier are checked in `beforeSwap`. Settlement raffles fan units first, then clears the rest at
  the highest losing bid. Claims, sell-back and maker withdrawals pay out by burning claims inside
  `unlockCallback`.
- `test/AuctionDrop.t.sol` — the SPEC §8.5 required tests plus a solvency fuzz (random bids,
  deposits, missing reveals, claims, sell-backs, withdrawals; every wei accounted for at the end).
- `test/AuctionDrop.fork.t.sol` — the whole auction through Sepolia's real Universal Router.
- `script/DeployAuction.s.sol` — HookMiner + CREATE2, then the maker opens the pool.
- Web: backend vouchers take `drop: "auction"`; `lib/bid.ts` encodes the bid as a Universal Router
  `V4_SWAP` (tested on an anvil fork with the exact transaction the page sends); `app/auction` page
  with sealed bid, reveal, results chart, claim, sell-back and a maker console.

## Decisions made while building

- **The pool pairs ETH with the hook contract itself.** A v4 pool needs two currencies; the hook
  nets every swap to zero, so the second currency is never transferred. Using the hook's own address
  avoids a dummy token and reads as "ETH → this drop's units". Consequence: bid routes must not
  `TAKE` currency1 (an ERC721 has no `transfer`), so the router call is swap + settle only.
- **`tx.origin` binds a bid to the voucher's wallet.** Through a router, `beforeSwap`'s `sender` is
  the router. Without a binding, anyone could copy a pending bid's hookData and front-run it with a
  1-wei deposit, burning that person's nullifier. Marked `ponytail:` in the code; smart-contract
  wallets would need a signed-deposit scheme or a trusted router's `msgSender()`.
- **Sell-back pays the unit's own price minus spread** (fan units: 定価). SPEC originally said the
  clearing price for every unit, which is insolvent when fan units are many: a fan unit brought in
  only 定価. SPEC §8.2 updated; flagged to the builder.
- **Maker opens the pool** (`beforeInitialize` checks the sender), so nobody can open it first with
  other parameters.
- **Raffle randomness from `prevrandao`**, marked as biasable by the block proposer; VRF for real
  stakes.
- **Ties at the cutoff go to the earlier bid** (deterministic, and the price is the tied amount
  either way).
- **Foundry:** the compiler pin was removed (v4's PoolManager is pinned to exactly 0.8.26 and the
  tests deploy it); the optimizer was turned on because the hook was 30.8 KB without it (17.8 KB with).

## Verified

- 17 unit tests + 1 fork test for the auction; 34 existing `Drop.sol` tests still pass.
- Deployed and verified on Sepolia: `0xec6239640c6531F97bD2a7d84115c6094a4B2888` (address suffix
  `0x2888` = the four hook flags). Pool initialized by the maker.
- A 7-bidder auction run on a local Sepolia fork and rendered in the page: raffle, auction winners,
  below-定価 and forfeited bids all shown correctly.
