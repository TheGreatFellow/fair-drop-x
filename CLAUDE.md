# CLAUDE.md

Hackathon project for ETHGlobal Tokyo 2026. Full context and all product decisions: @SPEC.md

## Phases (SPEC §4)
1. Core + World ID — **done** (2026-09-26), live and tested. `Drop.sol` is the fallback demo; never modify it.
2. Auction drop on Uniswap v4 (SPEC §8) — the headline mechanism now: multi-unit sealed-bid,
   uniform price, 定価 fan raffle, as a v4 hook. Build on branch `feat/auction-hook`, additive only;
   abandon and submit Phase 1 if it isn't working 2h before submission.

ENSv2 subnames were descoped on 2026-09-25 (reasoning in SPEC §5). Do not start ENS work.
Never start a phase before the previous one works end-to-end. Tell me if we're behind schedule.

## How to work
- Before coding a new part, read the relevant section of SPEC.md and state a short plan.
- Do not add features listed in "Explicitly out of scope" (SPEC §5) unless I ask.
- Prefer the simplest thing that works end-to-end. A working demo beats extra features.
- If something in SPEC.md is ambiguous or seems wrong, ask me instead of guessing.

## Stack
- Contracts: Foundry, Solidity, Sepolia
- Backend: Node/TypeScript, World ID IDKit v4 (server-side verification)
- Frontend: Next.js, wagmi, viem

## Rules
- Every contract change needs tests. Keep the solvency and maker-never-loses tests passing (SPEC §6.1 invariants, §6.4 economics).
- Never commit private keys or secrets; use `.env` (gitignored) and provide `.env.example`.
- Suggest a git commit after each working step (ETHGlobal disqualifies big single commits).
- For third-party SDKs (IDKit, ENSv2, Uniswap API), check current docs instead of relying on memory; they changed recently.
- Log notable prompts and decisions in `docs/ai/` for ETHGlobal's AI-attribution requirement.
