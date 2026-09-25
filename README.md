# Fair Drop

**Limited-edition merch at the normal price for early fans. After that, demand sets the price —
and the markup goes to the maker, not to scalpers.**

ETHGlobal Tokyo 2026 · built solo · Sepolia · World ID 4.0

- **Live demo:** _link added after deploy_
- **Contract:** [`0x897d36a3…eb9d3` on Sepolia](https://sepolia.etherscan.io/address/0x897d36a3d028776c3cdfc2e5a468544fdd1eb9d3#code) (verified)
- **World ID integration debrief:** [`docs/world-debrief.md`](docs/world-debrief.md)

## The problem

Japan sells a lot of limited-edition merch — anime goods, artist goods, trading cards, collabs.
Makers price it low on purpose and allocate first-come-first-served (先着) or by lottery (抽選).
It sells out in seconds, then resells at 10–20× the price. The markup goes to resellers (転売ヤー),
not the maker, and bots and multi-account buyers hoard the stock.

## How it works

1. **One per human.** Buying needs a World ID proof. The same person can never buy twice from a
   drop — not with a second wallet, and not after selling their unit back.
2. **Fan price first.** The first units all sell at the normal fixed price (定価), the price fans
   expect.
3. **Then demand pricing.** Every sale after that raises the price along a published curve, steeply
   at the end. While units remain, buying from the curve is the cheapest way to get one.
4. **Sell back any time.** Holders can return a unit for the current price minus a 5% spread. The
   unit is burned and the price drops for the next buyer.

We don't ban resale; we outcompete it.

## Why World ID

The attacker here is a scalper running many accounts. "One unit per real person" is exactly the
constraint that stops them, and it has to be a *unique human*, not a wallet, email or phone number.

We require **`proof_of_human`** (Orb-backed): the minimum assurance that actually stops one person
from being many buyers. A device-based credential would let the same scalper buy once per phone.
The backend enforces the credential rather than trusting what the widget asked for.

**The trust moment:** the buyer proves they're a unique human, bound to the wallet they're paying
from. Our backend verifies the proof with World server-side and signs an EIP-712 voucher carrying
the person's nullifier. The contract then records that nullifier itself and refuses it forever — so
one-per-person holds onchain even if the backend were bypassed.

## Architecture

```
 Browser (Next.js + wagmi)                Backend (Next.js route handlers)             Sepolia
 ─────────────────────────                ────────────────────────────────             ───────
 IDKit widget ──── POST /api/rp-context ──▶ sign the proof request (RP key)
      │
      │ proof ──── POST /api/verify ──────▶ • proof bound to this buyer's wallet?
      │                                     • verify with World (v4 endpoint)
      │                                     • environment + credential pinned
      │                                     • nullifier already used onchain? ──────▶ Drop.nullifierUsed
      │           ◀── EIP-712 voucher ───── • sign voucher (verifier key)
      │
 wallet ── buy(voucher) ─────────────────────────────────────────────────────────▶ Drop.sol
                                                                                   • check voucher signer
                                                                                   • record nullifier
                                                                                   • mint unit, sold++
```

| Part | Where |
|---|---|
| Contract: pricing, buy, sell-back, withdraw, redeem | [`src/Drop.sol`](src/Drop.sol) |
| Contract tests, including the invariant fuzz | [`test/Drop.t.sol`](test/Drop.t.sol) |
| World ID verification | [`web/lib/world.ts`](web/lib/world.ts) |
| Voucher signing + onchain check | [`web/lib/voucher.ts`](web/lib/voucher.ts) |
| API routes | [`web/app/api/`](web/app/api) |
| Drop page and price chart | [`web/app/page.tsx`](web/app/page.tsx), [`web/app/price-chart.tsx`](web/app/price-chart.tsx) |

## Guarantees, and how they're tested

The sell-back is the risky part: could a wave of sell-backs leave the contract unable to pay, or the
maker out of pocket? No — and the tests prove it rather than assert it.

- **Solvency.** After any sequence of buys, sell-backs and maker withdrawals, the contract holds at
  least what it would cost to buy back every outstanding unit. While the sale is open the maker can
  only withdraw what sits above that.
- **The maker never loses.** Each position on the curve is always bought for more than it is later
  bought back for, so every buy-then-sell-back leaves the maker the spread. Maker cash is always at
  least `units still sold × base price`.
- **One purchase per person, ever**, per drop — selling back doesn't free you to buy again.

`forge test` runs 34 contract tests, including SPEC §6.4's worked example checked row by row, a
cascade where every holder sells back and is paid in full, and a fuzz test that interleaves random
buys, sell-backs and withdrawals and checks both invariants after **every** step.

`npm test` in `web/` runs 20 backend tests. The important ones run against the real deployed
contract: the backend's voucher hash equals the contract's own `hashVoucher()`, and on a fork of
Sepolia a backend-signed voucher buys a unit while a second voucher for the same person is refused.

## World ID integration

IDKit 4.3, World ID 4.0, server-side verification through `POST /api/v4/verify/{rp_id}`. Checks
beyond "World said yes", each closing a specific hole:

- the proof's signal must be the buyer's wallet, so a proof can't be replayed for another wallet;
- the environment is pinned in both request and response, because anyone can mint unlimited
  staging identities in the simulator;
- the required credential is enforced;
- the RP ID comes from server config, never the client;
- nullifiers are compared as numbers, so `0x04e5` and `0x4e5` can't count as two people.

What we hit along the way — eleven friction points, from a contradictory `rp_context` shape across
doc pages to the simulator only ever being one v4 person — plus time to first success and the one
improvement we'd most like, are in **[`docs/world-debrief.md`](docs/world-debrief.md)**.

## Run it locally

Needs Foundry and Node 22.

```bash
git clone --recurse-submodules <this repo> && cd <repo>
cp .env.example .env        # fill in: RPC URL, keys, World app/RP IDs and signing key
forge test                  # contract tests

cd web
ln -s ../.env .env          # the web app shares the root .env
npm install
npm test                    # backend tests
npm run dev                 # http://localhost:3000
```

World ID runs in `staging` for development: verify using the web simulator at
[simulator.worldcoin.org](https://simulator.worldcoin.org).

**Test mode.** Setting `ALLOW_UNVERIFIED_TEST_BUYS=true` shows a switch to turn World ID off, so
one wallet can buy repeatedly and exercise the curve and sell-back. It removes the one-per-person
rule, so it only exists when explicitly enabled and never when `WORLD_ENVIRONMENT=production`.

To deploy your own drop: `forge script script/Deploy.s.sol --rpc-url $SEPOLIA_RPC_URL --broadcast`,
then update `deployments/sepolia.json` and run `npm run gen:drop` in `web/`.

## Known limitations

- **One simulated person on staging.** For World ID 4.0, the simulator always returns the same
  identity, so a second buyer can't be tested there (debrief item 11).
- **Some smart-account wallets can't receive units.** `buy()` mints with `_safeMint`; an EIP-7702
  smart account whose code doesn't accept ERC-721s makes the purchase revert.
- **Yen at demo scale.** Sepolia prices are tiny, so the page shows yen at a fixed, labelled scale
  (0.0002 ETH = ¥3,000).

## AI attribution

Built with Claude Code. The product spec, working agreement and every notable prompt and decision
are in the repo, as ETHGlobal requires: [`SPEC.md`](SPEC.md), [`CLAUDE.md`](CLAUDE.md) and
[`docs/ai/`](docs/ai).

## Credits

Studied for patterns and pitfalls; no code was copied.

- [`worldcoin/idkit`](https://github.com/worldcoin/idkit) Next.js example — the shape of the RP
  signing and verify routes.
- [Phora](https://ethglobal.com/showcase/phora-zj0cz) (ETHGlobal New York 2026) — raised the open
  question of whether World ID 4.0 nullifiers are deterministic, which we then tested.
- [Void Tactics](https://ethglobal.com/showcase/void-tactics-cont-ag25f) (ETHGlobal New York 2026) —
  confirmed that current Portal actions only work on the v4 endpoint.
- [hackpass](https://ethglobal.com/showcase/hackpass-2ghhd) (ETHOnline 2026) — the `rp_context`
  snake_case gotcha.
- [`worldcoin/simulator`](https://github.com/worldcoin/simulator) source — explained why staging is
  one v4 person.
- [Unisocks](https://github.com/Uniswap/unisocks) — proved curve pricing for merch in 2019. Fair Drop
  differs with a fixed fan price first and one unit per person.
