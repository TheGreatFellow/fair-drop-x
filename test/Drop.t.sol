// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Drop} from "../src/Drop.sol";

/// Uses the exact configuration from SPEC §6.4 so the worked example can be asserted directly
/// (values are wei here rather than yen, which keeps the numbers readable).
contract DropTest is Test {
    Drop internal drop;

    address internal maker = makeAddr("maker");
    uint256 internal verifierPk = 0xA11CE;
    address internal verifier = vm.addr(0xA11CE);
    bytes32 internal constant DROP_ID = keccak256("fair-drop/test");

    uint256 internal constant SUPPLY = 100;
    uint256 internal constant BASE_PRICE = 3000;
    uint256 internal constant FLAT_UNITS = 20;
    uint256 internal constant SLOPE = 150;
    uint256 internal constant STEEP_START = 90;
    uint256 internal constant STEEP_SLOPE = 1500;
    uint256 internal constant SPREAD_BPS = 500;

    uint256 internal saleEnd;

    function setUp() public {
        saleEnd = block.timestamp + 7 days;
        drop = new Drop("Fair Drop", "DROP", _config());
    }

    function _config() internal view returns (Drop.Config memory) {
        return Drop.Config({
            maker: maker,
            verifier: verifier,
            dropId: DROP_ID,
            supply: SUPPLY,
            basePrice: BASE_PRICE,
            flatUnits: FLAT_UNITS,
            slope: SLOPE,
            steepStart: STEEP_START,
            steepSlope: STEEP_SLOPE,
            spreadBps: SPREAD_BPS,
            saleEnd: saleEnd
        });
    }

    // --- pricing (SPEC §6.1) ---

    function test_FlatPhaseIsBasePrice() public view {
        for (uint256 i; i < FLAT_UNITS; ++i) {
            assertEq(drop.price(i), BASE_PRICE);
        }
    }

    function test_CurveStrictlyIncreasingAfterFlatPhase() public view {
        for (uint256 i = FLAT_UNITS - 1; i < SUPPLY - 1; ++i) {
            assertGt(drop.price(i + 1), drop.price(i));
        }
    }

    function test_SegmentsMatchSpecFormula() public view {
        assertEq(drop.price(FLAT_UNITS), BASE_PRICE + SLOPE);
        assertEq(drop.price(STEEP_START - 1), BASE_PRICE + SLOPE * (STEEP_START - FLAT_UNITS));
        assertEq(drop.price(STEEP_START), drop.price(STEEP_START - 1) + STEEP_SLOPE);
        assertEq(drop.price(SUPPLY - 1), drop.price(STEEP_START - 1) + STEEP_SLOPE * (SUPPLY - STEEP_START));
    }

    function test_CurveViewMatchesPrice() public view {
        uint256[] memory prices = drop.curve();
        assertEq(prices.length, SUPPLY);
        assertEq(prices[0], BASE_PRICE);
        assertEq(prices[SUPPLY - 1], drop.price(SUPPLY - 1));
    }

    function test_StartsInFlatPhaseWithFullSupply() public view {
        assertTrue(drop.flatPhaseActive());
        assertEq(drop.currentPrice(), BASE_PRICE);
        assertEq(drop.unitsLeft(), SUPPLY);
    }

    // --- config ---

    function test_ConstructorRejectsBadConfig() public {
        Drop.Config memory c = _config();

        c.spreadBps = 0;
        vm.expectRevert(Drop.BadConfig.selector);
        new Drop("x", "X", c);
        c.spreadBps = SPREAD_BPS;

        c.flatUnits = 0;
        vm.expectRevert(Drop.BadConfig.selector);
        new Drop("x", "X", c);

        c.flatUnits = STEEP_START;
        vm.expectRevert(Drop.BadConfig.selector);
        new Drop("x", "X", c);
        c.flatUnits = FLAT_UNITS;

        c.steepStart = SUPPLY + 1;
        vm.expectRevert(Drop.BadConfig.selector);
        new Drop("x", "X", c);
        c.steepStart = STEEP_START;

        c.saleEnd = block.timestamp;
        vm.expectRevert(Drop.BadConfig.selector);
        new Drop("x", "X", c);
    }
}
