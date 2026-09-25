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
