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
    uint256 internal nextNullifier = 1;

    /// Outstanding units, so a test can pick a real holder.
    address[] internal holders;
    uint256[] internal heldIds;

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

    // --- helpers ---

    function _voucher(address buyer, uint256 nullifier)
        internal
        view
        returns (Drop.Voucher memory v, bytes memory sig)
    {
        v = Drop.Voucher({dropId: DROP_ID, buyer: buyer, nullifierHash: nullifier, deadline: block.timestamp + 1 hours});
        (uint8 yv, bytes32 r, bytes32 s) = vm.sign(verifierPk, drop.hashVoucher(v));
        sig = abi.encodePacked(r, s, yv);
    }

    /// Buys one unit as a fresh verified human at the current curve price.
    function _buy() internal returns (address buyer, uint256 tokenId) {
        uint256 nullifier = nextNullifier++;
        buyer = address(uint160(0x10000 + nullifier));
        vm.deal(buyer, 10 ether);
        (Drop.Voucher memory v, bytes memory sig) = _voucher(buyer, nullifier);
        uint256 p = drop.currentPrice();
        vm.prank(buyer);
        drop.buy{value: p}(v, sig);
        tokenId = drop.nextTokenId();
        holders.push(buyer);
        heldIds.push(tokenId);
    }

    function _sellBackAt(uint256 index) internal {
        address holder = holders[index];
        uint256 tokenId = heldIds[index];
        vm.prank(holder);
        drop.sellBack(tokenId);
        holders[index] = holders[holders.length - 1];
        heldIds[index] = heldIds[heldIds.length - 1];
        holders.pop();
        heldIds.pop();
    }

    /// Everything the maker has received and not paid back out: contract balance plus withdrawals.
    function _makerCash() internal view returns (uint256) {
        return address(drop).balance + maker.balance;
    }

    function _assertInvariants() internal view {
        // SPEC §6.1 solvency: every outstanding unit is always buy-backable.
        assertGe(address(drop).balance, drop.liability(), "solvency");
        // SPEC §6.1 maker-never-loses.
        assertGe(_makerCash(), drop.curveSum(), "maker cash >= curve revenue of units still sold");
        assertGe(_makerCash(), drop.sold() * BASE_PRICE, "maker cash >= sold * basePrice");
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

    function test_FlatPhaseRunsOutAfterFlatUnits() public {
        for (uint256 i; i < FLAT_UNITS; ++i) {
            _buy();
        }
        assertFalse(drop.flatPhaseActive());
        assertEq(drop.currentPrice(), BASE_PRICE + SLOPE);
        assertEq(drop.unitsLeft(), SUPPLY - FLAT_UNITS);
    }

    // --- buy ---

    function test_BuyChargesFlatPriceAndMints() public {
        (address buyer, uint256 tokenId) = _buy();
        assertEq(drop.ownerOf(tokenId), buyer);
        assertEq(drop.sold(), 1);
        assertEq(drop.curveSum(), BASE_PRICE);
        assertEq(address(drop).balance, BASE_PRICE);
    }

    function test_BuyRefundsExcess() public {
        address buyer = address(0xB0B);
        vm.deal(buyer, 1 ether);
        (Drop.Voucher memory v, bytes memory sig) = _voucher(buyer, 1);
        vm.prank(buyer);
        drop.buy{value: 1 ether}(v, sig);
        assertEq(buyer.balance, 1 ether - BASE_PRICE);
        assertEq(address(drop).balance, BASE_PRICE);
    }

    /// The demo's required alternative path: same human, second attempt.
    function test_BuyRejectsReusedNullifier() public {
        address buyer = address(0xB0B);
        vm.deal(buyer, 1 ether);
        (Drop.Voucher memory v, bytes memory sig) = _voucher(buyer, 42);
        vm.prank(buyer);
        drop.buy{value: BASE_PRICE}(v, sig);

        vm.prank(buyer);
        vm.expectRevert(Drop.AlreadyPurchased.selector);
        drop.buy{value: BASE_PRICE}(v, sig);
    }

    function test_BuyRejectsForgedSignature() public {
        address buyer = address(0xB0B);
        vm.deal(buyer, 1 ether);
        Drop.Voucher memory v =
            Drop.Voucher({dropId: DROP_ID, buyer: buyer, nullifierHash: 7, deadline: block.timestamp + 1 hours});
        (uint8 yv, bytes32 r, bytes32 s) = vm.sign(0xBADBAD, drop.hashVoucher(v));
        vm.prank(buyer);
        vm.expectRevert(Drop.BadSignature.selector);
        drop.buy{value: BASE_PRICE}(v, abi.encodePacked(r, s, yv));
    }

    function test_BuyRejectsVoucherForSomeoneElse() public {
        (Drop.Voucher memory v, bytes memory sig) = _voucher(address(0xB0B), 7);
        vm.deal(address(0xBAD), 1 ether);
        vm.prank(address(0xBAD));
        vm.expectRevert(Drop.WrongBuyer.selector);
        drop.buy{value: BASE_PRICE}(v, sig);
    }

    function test_BuyRejectsWrongDropId() public {
        address buyer = address(0xB0B);
        vm.deal(buyer, 1 ether);
        Drop.Voucher memory v = Drop.Voucher({
            dropId: keccak256("other-drop"), buyer: buyer, nullifierHash: 7, deadline: block.timestamp + 1 hours
        });
        (uint8 yv, bytes32 r, bytes32 s) = vm.sign(verifierPk, drop.hashVoucher(v));
        vm.prank(buyer);
        vm.expectRevert(Drop.WrongDrop.selector);
        drop.buy{value: BASE_PRICE}(v, abi.encodePacked(r, s, yv));
    }

    function test_BuyRejectsExpiredVoucher() public {
        address buyer = address(0xB0B);
        vm.deal(buyer, 1 ether);
        (Drop.Voucher memory v, bytes memory sig) = _voucher(buyer, 7);
        vm.warp(block.timestamp + 2 hours);
        vm.prank(buyer);
        vm.expectRevert(Drop.VoucherExpired.selector);
        drop.buy{value: BASE_PRICE}(v, sig);
    }

    function test_BuyRejectsUnderpayment() public {
        address buyer = address(0xB0B);
        vm.deal(buyer, 1 ether);
        (Drop.Voucher memory v, bytes memory sig) = _voucher(buyer, 7);
        vm.prank(buyer);
        vm.expectRevert(Drop.Underpaid.selector);
        drop.buy{value: BASE_PRICE - 1}(v, sig);
    }

    function test_BuyRejectsAfterSaleEnd() public {
        address buyer = address(0xB0B);
        vm.deal(buyer, 1 ether);
        (Drop.Voucher memory v, bytes memory sig) = _voucher(buyer, 7);
        vm.warp(saleEnd);
        vm.prank(buyer);
        vm.expectRevert(Drop.SaleClosed.selector);
        drop.buy{value: BASE_PRICE}(v, sig);
    }

    function test_BuyRejectsWhenSoldOut() public {
        for (uint256 i; i < SUPPLY; ++i) {
            _buy();
        }
        address buyer = address(0xB0B);
        vm.deal(buyer, 10 ether);
        (Drop.Voucher memory v, bytes memory sig) = _voucher(buyer, 9999);
        vm.prank(buyer);
        vm.expectRevert(Drop.SoldOut.selector);
        drop.buy{value: 1 ether}(v, sig);
    }

    function test_EditionNumbersAreSequential() public {
        (, uint256 first) = _buy();
        (, uint256 second) = _buy();
        assertEq(first, 1);
        assertEq(second, 2);
    }

    // --- sell-back ---

    function test_SellBackPaysBelowWhatLastBuyerPaid() public {
        for (uint256 i; i < FLAT_UNITS + 5; ++i) {
            _buy();
        }
        uint256 lastPaid = drop.price(drop.sold() - 1);
        uint256 payout = drop.currentSellBackPrice();
        assertLt(payout, lastPaid, "payout must be below the last purchase price");
        assertEq(payout, lastPaid * (10_000 - SPREAD_BPS) / 10_000);

        uint256 index = holders.length - 1;
        address holder = holders[index];
        uint256 before = holder.balance;
        _sellBackAt(index);
        assertEq(holder.balance - before, payout);
        _assertInvariants();
    }

    function test_SellBackLowersPriceForNextBuyer() public {
        for (uint256 i; i < FLAT_UNITS + 5; ++i) {
            _buy();
        }
        uint256 priceBefore = drop.currentPrice();
        _sellBackAt(holders.length - 1);
        assertEq(drop.currentPrice(), priceBefore - SLOPE);
    }

    function test_SellBackPayoutRoundsDown() public {
        // price(20) == 3150; 3150 * 9500 / 10000 == 2992.5 -> 2992.
        for (uint256 i; i < FLAT_UNITS + 1; ++i) {
            _buy();
        }
        assertEq(drop.price(FLAT_UNITS), 3150);
        assertEq(drop.currentSellBackPrice(), 2992);
    }

    /// Selling back must not free the human to buy again (SPEC §3.1, no cycling).
    function test_SellBackDoesNotFreeNullifier() public {
        address buyer = address(0xB0B);
        vm.deal(buyer, 1 ether);
        (Drop.Voucher memory v, bytes memory sig) = _voucher(buyer, 42);
        vm.prank(buyer);
        drop.buy{value: BASE_PRICE}(v, sig);

        vm.prank(buyer);
        drop.sellBack(1);

        vm.prank(buyer);
        vm.expectRevert(Drop.AlreadyPurchased.selector);
        drop.buy{value: BASE_PRICE}(v, sig);
    }

    /// Sold-back units return to the drop and can be bought again by someone else.
    function test_SoldBackUnitsAreBuyableAgain() public {
        for (uint256 i; i < 30; ++i) {
            _buy();
        }
        _sellBackAt(holders.length - 1);
        assertEq(drop.unitsLeft(), SUPPLY - 29);
        (, uint256 tokenId) = _buy();
        assertEq(drop.sold(), 30);
        assertEq(tokenId, 31, "edition numbers are never reused");
        _assertInvariants();
    }

    function test_SellBackRejectsNonOwner() public {
        _buy();
        vm.prank(address(0xBAD));
        vm.expectRevert(Drop.NotOwner.selector);
        drop.sellBack(1);
    }

    function test_SellBackClosesWithSale() public {
        (address buyer,) = _buy();
        vm.warp(saleEnd);
        vm.prank(buyer);
        vm.expectRevert(Drop.SaleClosed.selector);
        drop.sellBack(1);
    }

    // --- withdraw ---

    function test_WithdrawLeavesFullBuyBackLiability() public {
        for (uint256 i; i < 30; ++i) {
            _buy();
        }
        uint256 owed = drop.liability();
        assertEq(drop.withdrawable(), address(drop).balance - owed);

        vm.prank(maker);
        drop.withdraw();

        assertEq(address(drop).balance, owed);
        assertEq(drop.withdrawable(), 0);
        _assertInvariants();

        // Every outstanding unit is still sellable back after the maker took its cut.
        while (holders.length > 0) {
            _sellBackAt(holders.length - 1);
            _assertInvariants();
        }
    }

    function test_WithdrawTakesEverythingAfterSaleEnd() public {
        for (uint256 i; i < 30; ++i) {
            _buy();
        }
        uint256 total = address(drop).balance;
        vm.warp(saleEnd);
        vm.prank(maker);
        drop.withdraw();
        assertEq(address(drop).balance, 0);
        assertEq(maker.balance, total);
    }

    function test_WithdrawOnlyMaker() public {
        _buy();
        vm.expectRevert(Drop.NotMaker.selector);
        drop.withdraw();
    }

    function test_WithdrawRevertsWhenNothingFree() public {
        _buy();
        vm.prank(maker);
        drop.withdraw();
        vm.prank(maker);
        vm.expectRevert(Drop.NothingToWithdraw.selector);
        drop.withdraw();
    }

    // --- redeem ---

    function test_RedeemAfterSaleEndBurnsUnit() public {
        (address buyer, uint256 tokenId) = _buy();
        vm.warp(saleEnd);
        vm.prank(buyer);
        drop.redeem(tokenId);
        vm.expectRevert();
        drop.ownerOf(tokenId);
    }

    function test_RedeemBlockedWhileSaleOpen() public {
        (address buyer, uint256 tokenId) = _buy();
        vm.prank(buyer);
        vm.expectRevert(Drop.SaleStillOpen.selector);
        drop.redeem(tokenId);
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
