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
    f"export const DROP_VERIFIER = \"{d['verifier']}\" as const;\n\n"
    "export const dropAbi = " + json.dumps(abi, indent=2) + " as const;\n"
)
print("wrote web/lib/drop.ts")
