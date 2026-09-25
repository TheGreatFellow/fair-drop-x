// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {AuctionDrop} from "../src/AuctionDrop.sol";

/// @notice Deploys an auction drop hook at a mined address and opens its pool (SPEC §8.4).
///         The broadcaster must be the maker: only the maker may initialize the pool.
///
/// Deploy: forge script script/DeployAuction.s.sol --rpc-url $SEPOLIA_RPC_URL --broadcast --verify
contract DeployAuction is Script {
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    // Sepolia. Pool fee and tick spacing don't matter: the hook nets every swap to zero.
    IPoolManager constant POOL_MANAGER = IPoolManager(0xE03A1074c86CFeDd5C142C4F04F1a1536e203543);
    uint24 constant FEE = 0;
    int24 constant TICK_SPACING = 1;
    uint160 constant SQRT_PRICE_1_1 = 79228162514264337593543950336;

    function run() external returns (AuctionDrop hook) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        AuctionDrop.Config memory c = AuctionDrop.Config({
            maker: deployer,
            verifier: vm.envOr("VERIFIER_ADDRESS", deployer),
            dropId: keccak256(bytes(vm.envOr("AUCTION_DROP_ID", string("fair-drop/auction-1")))),
            supply: vm.envOr("AUCTION_SUPPLY", uint256(5)),
            fanUnits: vm.envOr("AUCTION_FAN_UNITS", uint256(2)),
            reservePrice: vm.envOr("AUCTION_RESERVE", uint256(0.0002 ether)),
            spreadBps: vm.envOr("SPREAD_BPS", uint256(500)),
            minRevealTime: vm.envOr("AUCTION_MIN_REVEAL_SECONDS", uint256(120)),
            saleEnd: block.timestamp + vm.envOr("SALE_DURATION_HOURS", uint256(72)) * 1 hours
        });

        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG
                | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
        );
        bytes memory args = abi.encode(POOL_MANAGER, c);
        (address expected, bytes32 salt) =
            HookMiner.find(CREATE2_DEPLOYER, flags, type(AuctionDrop).creationCode, args);

        vm.startBroadcast(deployerKey);
        hook = new AuctionDrop{salt: salt}(POOL_MANAGER, c);
        require(address(hook) == expected, "hook address mismatch");
        PoolKey memory key =
            PoolKey(Currency.wrap(address(0)), Currency.wrap(address(hook)), FEE, TICK_SPACING, IHooks(address(hook)));
        POOL_MANAGER.initialize(key, SQRT_PRICE_1_1);
        vm.stopBroadcast();

        console.log("AuctionDrop   ", address(hook));
        console.log("maker         ", c.maker);
        console.log("verifier      ", c.verifier);
        console.log("dropId        ", vm.toString(c.dropId));
        console.log("supply        ", c.supply);
        console.log("fanUnits      ", c.fanUnits);
        console.log("reserve wei   ", c.reservePrice);
        console.log("saleEnd       ", c.saleEnd);
        console.log("poolId        ", vm.toString(keccak256(abi.encode(key))));
    }
}
