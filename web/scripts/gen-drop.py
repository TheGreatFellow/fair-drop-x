"""Regenerates web/lib/drop.ts from the Foundry build and deployments/sepolia.json."""
import json, pathlib

root = pathlib.Path(__file__).resolve().parents[2]
abi = json.loads((root / "out/Drop.sol/Drop.json").read_text())["abi"]
d = json.loads((root / "deployments/sepolia.json").read_text())
(root / "web/lib/drop.ts").write_text(
    "// Generated from out/Drop.sol/Drop.json and deployments/sepolia.json. Do not edit by hand.\n"
    "// Regenerate after a redeploy: `npm run gen:drop` in web/.\n\n"
    f"export const DROP_ADDRESS = \"{d['drop']}\" as const;\n"
    f"export const DROP_CHAIN_ID = {d['chainId']} as const;\n"
    f"export const DROP_ID = \"{d['dropId']}\" as const;\n"
    f"export const DROP_VERIFIER = \"{d['verifier']}\" as const;\n"
    f"export const DROP_DEPLOY_BLOCK = {d['deployBlock']}n;\n\n"
    "export const dropAbi = " + json.dumps(abi, indent=2) + " as const;\n"
)
print("wrote web/lib/drop.ts")

# The auction drop (SPEC §8). Built by two compilers (see foundry.toml); the ABI is identical.
art = next((root / "out/AuctionDrop.sol").glob("AuctionDrop*.json"))
abi = json.loads(art.read_text())["abi"]
a = json.loads((root / "deployments/sepolia-auction.json").read_text())
(root / "web/lib/auction.ts").write_text(
    "// Generated from out/AuctionDrop.sol and deployments/sepolia-auction.json. Do not edit by hand.\n"
    "// Regenerate after a redeploy: `npm run gen:drop` in web/.\n\n"
    f"export const AUCTION_ADDRESS = \"{a['auction']}\" as const;\n"
    f"export const AUCTION_ID = \"{a['dropId']}\" as const;\n"
    f"export const AUCTION_DEPLOY_BLOCK = {a['deployBlock']}n;\n"
    f"export const UNIVERSAL_ROUTER = \"{a['universalRouter']}\" as const;\n"
    f"export const POOL_FEE = {a['poolFee']};\n"
    f"export const TICK_SPACING = {a['tickSpacing']};\n\n"
    "export const auctionAbi = " + json.dumps(abi, indent=2) + " as const;\n"
)
print("wrote web/lib/auction.ts")
