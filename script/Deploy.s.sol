// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {Drop} from "../src/Drop.sol";

/// @notice Deploys one drop. Defaults are the demo configuration from SPEC §9 — a small
///         `flatUnits` so the flat phase runs out live in front of the judges — and every value
///         can be overridden from `.env`. See `.env.example`.
///
/// Simulate:  forge script script/Deploy.s.sol
/// Deploy:    forge script script/Deploy.s.sol --rpc-url $SEPOLIA_RPC_URL --broadcast --verify
contract Deploy is Script {
    function run() external returns (Drop drop) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        // The maker receives the proceeds; the verifier is the backend key that signs vouchers.
        // Both default to the deployer so a bare `forge script` simulation needs no extra config.
        Drop.Config memory c = Drop.Config({
            maker: vm.envOr("MAKER_ADDRESS", deployer),
            verifier: vm.envOr("VERIFIER_ADDRESS", deployer),
            dropId: keccak256(bytes(vm.envOr("DROP_ID", string("fair-drop/demo-1")))),
            supply: vm.envOr("SUPPLY", uint256(20)),
            basePrice: vm.envOr("BASE_PRICE", uint256(0.0002 ether)),
            flatUnits: vm.envOr("FLAT_UNITS", uint256(3)),
            slope: vm.envOr("SLOPE", uint256(0.00005 ether)),
            steepStart: vm.envOr("STEEP_START", uint256(18)),
            steepSlope: vm.envOr("STEEP_SLOPE", uint256(0.0005 ether)),
            spreadBps: vm.envOr("SPREAD_BPS", uint256(500)),
            saleEnd: block.timestamp + vm.envOr("SALE_DURATION_HOURS", uint256(72)) * 1 hours
        });

        vm.startBroadcast(deployerKey);
        drop = new Drop(
            vm.envOr("DROP_NAME", string("Fair Drop Demo")), vm.envOr("DROP_SYMBOL", string("DROP")), c
        );
        vm.stopBroadcast();

        console.log("Drop          ", address(drop));
        console.log("maker         ", c.maker);
        console.log("verifier      ", c.verifier);
        console.log("dropId        ", vm.toString(c.dropId));
        console.log("supply        ", c.supply);
        console.log("flatUnits     ", c.flatUnits);
        console.log("basePrice wei ", c.basePrice);
        console.log("last unit wei ", drop.price(c.supply - 1));
        console.log("saleEnd       ", c.saleEnd);
    }
}
