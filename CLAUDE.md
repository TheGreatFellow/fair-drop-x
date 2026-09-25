# CLAUDE.md

Hackathon project for ETHGlobal Tokyo 2026. Full context and all product decisions: @SPEC.md

## Phases (SPEC §4)
1. Core + World ID — build this first, fully working. **This is the submission.**
2. Uniswap pay-with-any-token — only if Phase 1 works end-to-end with hours to spare.

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
