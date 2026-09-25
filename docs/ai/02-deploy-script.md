# Phase 1 — deploy script

**Tool:** Claude Code (Opus 5), 2026-09-25.

**Prompt:** "go ahead with 1, also let me know what you want from my side." (step 1 of the
proposed next steps: deploy script + Sepolia deploy)

## Decisions

- **Every config value reads through `vm.envOr` with a demo default**, so `forge script` runs
  and self-checks with no `.env` at all, while a real deploy overrides whatever it needs. Only
  `PRIVATE_KEY` is mandatory.
- **`maker` and `verifier` default to the deployer.** Convenient for a local simulation; both
  should be set explicitly for the real Sepolia deploy, since the verifier's private key has to
  live on the backend and nowhere else.
- **Demo configuration per SPEC §9**: supply 20, `flatUnits` 3, `basePrice` 0.0002 ETH, slope
  0.00005 ETH, `steepStart` 18, `steepSlope` 0.0005 ETH, spread 500 bps, 72-hour sale. The flat
  phase is only three units so it runs out live during judging, and the last unit costs
  0.00195 ETH — the whole curve is about 0.012 ETH, so judges need roughly 0.0003 ETH each.
- **`dropId` is `keccak256` of a human-readable string** (`fair-drop/demo-1`) rather than a raw
  bytes32, so the same value can be typed into the World Developer Portal action and the backend
  config without transcription errors.

The simulation output doubles as the check that the demo config satisfies the constructor's
`0 < flatUnits < steepStart <= supply` and non-zero-spread constraints.

## Deployed

Sepolia, 2026-09-25: `0x897d36a3d028776c3cdfc2e5a468544fdd1eb9d3`
(tx `0x30c709885fd6ec500995d3d3cb538788949f03215174395a49b710c7029997bc`).

Deployed over a public Sepolia endpoint rather than Infura, because the Infura key was not yet
available and deploying once does not need a dedicated endpoint. The frontend should move to a
dedicated RPC before judging, since public endpoints rate-limit under load.

Source is verified on Sourcify with an exact creation and runtime bytecode match. Etherscan
verification was not done at deploy time: there is no Etherscan API key in `.env` yet, and
Sourcify's relayed Etherscan submission hit its shared daily rate limit. Routescan picked it up.
Worth revisiting with an own API key before submission, since judges clicking through to
verified source on Etherscan is free credibility.

`saleEnd` is 2026-09-28T12:39:36Z — deliberately after the Sunday 09:00 JST submission deadline,
so the sale is still open while judges buy. The consequence is that `redeem()` and the
after-close branch of `withdraw()` cannot be demonstrated on this deployment; a second
short-lived drop would be needed to show those.
