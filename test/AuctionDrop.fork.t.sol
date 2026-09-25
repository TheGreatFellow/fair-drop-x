// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IV4Router} from "@uniswap/v4-periphery/src/interfaces/IV4Router.sol";
import {AuctionDrop} from "../src/AuctionDrop.sol";

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// Bids go through Sepolia's real Universal Router and PoolManager — the exact calls the web app
/// makes. Skipped without SEPOLIA_RPC_URL.
contract AuctionDropForkTest is Test {
    IPoolManager constant PM = IPoolManager(0xE03A1074c86CFeDd5C142C4F04F1a1536e203543);
    IUniversalRouter constant UR = IUniversalRouter(0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b);
    uint8 constant V4_SWAP = 0x10;
    uint8 constant SWAP_EXACT_IN_SINGLE = 0x06;
    uint8 constant SETTLE_ALL = 0x0c;
    bytes32 constant DROP_ID = keccak256("fair-drop/auction-fork");

    AuctionDrop hook;
    PoolKey key;
    address maker = makeAddr("maker");
    address verifier;
    uint256 verifierKey;

    function setUp() public {
        string memory rpc = vm.envOr("SEPOLIA_RPC_URL", string(""));
        vm.skip(bytes(rpc).length == 0);
        vm.createSelectFork(rpc);
        (verifier, verifierKey) = makeAddrAndKey("verifier");

        AuctionDrop.Config memory c =
            AuctionDrop.Config(maker, verifier, DROP_ID, 2, 1, 0.0002 ether, 120);
        address at = address(
            uint160(
                Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG
                    | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
            ) | (uint160(0xFA12) << 144)
        );
        deployCodeTo("AuctionDrop.sol:AuctionDrop", abi.encode(PM, c), at);
        hook = AuctionDrop(at);
        key = PoolKey(Currency.wrap(address(0)), Currency.wrap(at), 0, 1, IHooks(at));
        vm.prank(maker);
        PM.initialize(key, 79228162514264337593543950336);
    }

    function _bid(address who, uint256 amount, uint256 nullifier) internal {
        AuctionDrop.Voucher memory v = AuctionDrop.Voucher(DROP_ID, who, nullifier, block.timestamp + 900);
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(verifierKey, hook.hashVoucher(v));
        bytes memory hookData =
            abi.encode(v, abi.encodePacked(r, s, sv), hook.commitmentOf(amount, bytes32(nullifier), who));

        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(IV4Router.ExactInputSingleParams(key, true, uint128(amount), 0, hookData));
        params[1] = abi.encode(Currency.wrap(address(0)), amount);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(abi.encodePacked(SWAP_EXACT_IN_SINGLE, SETTLE_ALL), params);

        vm.deal(who, amount);
        vm.prank(who, who);
        UR.execute{value: amount}(abi.encodePacked(V4_SWAP), inputs, block.timestamp + 60);
    }

    function test_FullAuctionThroughUniversalRouter() public {
        address a = makeAddr("a");
        address b = makeAddr("b");
        address c = makeAddr("c");
        _bid(a, 0.0005 ether, 1);
        _bid(b, 0.0009 ether, 2);
        _bid(c, 0.0007 ether, 3);
        assertEq(PM.balanceOf(address(hook), 0), 0.0021 ether, "deposits held as the hook's claims");

        vm.prank(maker);
        hook.closeBidding();
        vm.prank(a);
        hook.reveal(0.0005 ether, bytes32(uint256(1)));
        vm.prank(b);
        hook.reveal(0.0009 ether, bytes32(uint256(2)));
        vm.prank(c);
        hook.reveal(0.0007 ether, bytes32(uint256(3)));
        vm.warp(block.timestamp + 120);
        vm.prank(maker);
        hook.settle();

        // One fan unit, one auction unit, three bidders: the auction unit clears at the bid of
        // whoever is left out, whichever two the raffle split.
        assertEq(hook.fanWinners() + hook.auctionWinners(), 2);
        address[3] memory all = [a, b, c];
        for (uint256 i; i < 3; i++) {
            vm.prank(all[i]);
            hook.claim();
        }
        assertEq(hook.balanceOf(a) + hook.balanceOf(b) + hook.balanceOf(c), 2);

        vm.prank(maker);
        hook.withdraw();
        assertEq(PM.balanceOf(address(hook), 0), 0, "every deposit paid out: refunds + proceeds");
    }
}
