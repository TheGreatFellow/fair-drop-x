// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {AuctionDrop} from "../src/AuctionDrop.sol";

contract AuctionDropTest is Deployers { // Deployers brings v4-core's own forge-std Test
    uint160 constant FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG
            | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
    );
    uint256 constant RESERVE = 1 ether;
    uint256 constant SPREAD = 500;
    uint256 constant MIN_REVEAL = 120;
    bytes32 constant DROP_ID = keccak256("fair-drop/auction-test");

    AuctionDrop hook;
    PoolKey poolKey;
    address maker = makeAddr("maker");
    address verifier;
    uint256 verifierKey;
    uint256 saleEnd;
    uint256 deploys;
    uint256 nextNullifier = 1;

    function setUp() public {
        deployFreshManagerAndRouters();
        (verifier, verifierKey) = makeAddrAndKey("verifier");
        saleEnd = block.timestamp + 1 days;
    }

    // ─────────────── helpers ───────────────

    function _deploy(uint256 supply, uint256 fans) internal {
        AuctionDrop.Config memory c = AuctionDrop.Config({
            maker: maker,
            verifier: verifier,
            dropId: DROP_ID,
            supply: supply,
            fanUnits: fans,
            reservePrice: RESERVE,
            spreadBps: SPREAD,
            minRevealTime: MIN_REVEAL,
            saleEnd: saleEnd
        });
        // The low 14 bits carry the hook permissions; the high bits just make each deploy unique.
        address at = address(FLAGS | (uint160(++deploys) << 144));
        deployCodeTo("AuctionDrop.sol:AuctionDrop", abi.encode(manager, c), at);
        hook = AuctionDrop(at);
        poolKey = PoolKey(Currency.wrap(address(0)), Currency.wrap(at), 0, 1, IHooks(at));
        vm.prank(maker);
        manager.initialize(poolKey, SQRT_PRICE_1_1);
    }

    function _secret(address who) internal pure returns (bytes32) {
        return keccak256(abi.encode("secret", who));
    }

    function _hookData(address who, uint256 amount, uint256 nullifier, uint256 key) internal view returns (bytes memory) {
        AuctionDrop.Voucher memory v = AuctionDrop.Voucher(DROP_ID, who, nullifier, block.timestamp + 15 minutes);
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(key, hook.hashVoucher(v));
        return abi.encode(v, abi.encodePacked(r, s, sv), hook.commitmentOf(amount, _secret(who), who));
    }

    function _swap(address who, uint256 deposit, bytes memory hookData) internal {
        vm.deal(who, who.balance + deposit);
        vm.prank(who, who); // tx.origin = bidder, as with a wallet going through a router
        swapRouter.swap{value: deposit}(
            poolKey,
            SwapParams({zeroForOne: true, amountSpecified: -int256(deposit), sqrtPriceLimitX96: MIN_PRICE_LIMIT}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            hookData
        );
    }

    function _bid(address who, uint256 amount, uint256 deposit) internal {
        _swap(who, deposit, _hookData(who, amount, nextNullifier++, verifierKey));
    }

    function _bid(address who, uint256 amount) internal {
        _bid(who, amount, amount);
    }

    function _reveal(address who, uint256 amount) internal {
        vm.prank(who);
        hook.reveal(amount, _secret(who));
    }

    function _closeRevealSettle(address[] memory who, uint256[] memory amounts) internal {
        vm.prank(maker);
        hook.closeBidding();
        for (uint256 i; i < who.length; i++) {
            _reveal(who[i], amounts[i]);
        }
        vm.warp(block.timestamp + MIN_REVEAL);
        vm.prank(maker);
        hook.settle();
    }

    function _hookError(bytes4 hookSelector, bytes4 err) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            CustomRevert.WrappedError.selector,
            address(hook),
            hookSelector,
            abi.encodeWithSelector(err),
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
    }

    function _outcome(address who) internal view returns (AuctionDrop.Outcome o) {
        (,,,,, o) = hook.bids(who);
    }

    function _claims() internal view returns (uint256) {
        return manager.balanceOf(address(hook), 0);
    }

    /// Bids placed with amounts[i] by fresh wallets, all revealed, then settled.
    function _run(uint256[] memory amounts) internal returns (address[] memory who) {
        who = new address[](amounts.length);
        for (uint256 i; i < amounts.length; i++) {
            who[i] = makeAddr(string(abi.encode("bidder", i)));
            _bid(who[i], amounts[i]);
        }
        _closeRevealSettle(who, amounts);
    }

    function _amounts(uint256 a, uint256 b, uint256 c, uint256 d, uint256 e) internal pure returns (uint256[] memory x) {
        x = new uint256[](5);
        (x[0], x[1], x[2], x[3], x[4]) = (a * 1 ether, b * 1 ether, c * 1 ether, d * 1 ether, e * 1 ether);
    }

    // ─────────────── pricing ───────────────

    function test_UniformPriceIsHighestLosingBid() public {
        _deploy(3, 0);
        address[] memory who = _run(_amounts(5, 2, 4, 3, 6));

        assertEq(hook.clearingPrice(), 3 ether, "price = highest losing bid");
        assertEq(hook.auctionWinners(), 3);
        assertEq(uint8(_outcome(who[0])), uint8(AuctionDrop.Outcome.Auction)); // 5
        assertEq(uint8(_outcome(who[2])), uint8(AuctionDrop.Outcome.Auction)); // 4
        assertEq(uint8(_outcome(who[4])), uint8(AuctionDrop.Outcome.Auction)); // 6
        assertEq(uint8(_outcome(who[1])), uint8(AuctionDrop.Outcome.None)); // 2
        assertEq(uint8(_outcome(who[3])), uint8(AuctionDrop.Outcome.None)); // 3, the highest loser
    }

    function test_FewerBidsThanUnitsPayReserve() public {
        _deploy(5, 0);
        uint256[] memory amounts = new uint256[](2);
        (amounts[0], amounts[1]) = (7 ether, 2 ether);
        address[] memory who = _run(amounts);

        assertEq(hook.clearingPrice(), RESERVE);
        assertEq(hook.auctionWinners(), 2);
        vm.prank(who[0]);
        hook.claim();
        assertEq(who[0].balance, 7 ether - RESERVE, "pays the reserve, not the bid");
    }

    function test_BidsBelowReserveNeverWin() public {
        _deploy(3, 1);
        uint256[] memory amounts = new uint256[](3);
        (amounts[0], amounts[1], amounts[2]) = (0.5 ether, 4 ether, 5 ether);
        address[] memory who = _run(amounts);

        assertEq(uint8(_outcome(who[0])), uint8(AuctionDrop.Outcome.None));
        assertEq(hook.clearingPrice(), RESERVE, "a below-reserve bid is not a losing bid that sets the price");
        vm.prank(who[0]);
        hook.claim();
        assertEq(who[0].balance, 0.5 ether, "refunded in full");
    }

    function test_TiesGoToTheEarlierBid() public {
        _deploy(1, 0);
        uint256[] memory amounts = new uint256[](2);
        (amounts[0], amounts[1]) = (3 ether, 3 ether);
        address[] memory who = _run(amounts);

        assertEq(uint8(_outcome(who[0])), uint8(AuctionDrop.Outcome.Auction));
        assertEq(uint8(_outcome(who[1])), uint8(AuctionDrop.Outcome.None));
        assertEq(hook.clearingPrice(), 3 ether);
    }

    /// Whatever the raffle draws: fan units only go to bids ≥ 定価, and among everyone else the
    /// auction is exactly a uniform-price auction.
    function testFuzz_RaffleOnlyAmongReserveBidsAndAuctionUnaffected(uint256 rand) public {
        _deploy(4, 2);
        vm.prevrandao(bytes32(rand));
        uint256[] memory amounts = new uint256[](7);
        (amounts[0], amounts[1], amounts[2], amounts[3]) = (0.5 ether, 1 ether, 2 ether, 3 ether);
        (amounts[4], amounts[5], amounts[6]) = (4 ether, 5 ether, 0.9 ether);
        address[] memory who = _run(amounts);

        uint256 price = hook.clearingPrice();
        uint256 fans;
        uint256 auction;
        uint256 highestLoser;
        for (uint256 i; i < who.length; i++) {
            AuctionDrop.Outcome o = _outcome(who[i]);
            if (amounts[i] < RESERVE) {
                assertEq(uint8(o), uint8(AuctionDrop.Outcome.None), "below reserve never wins");
            } else if (o == AuctionDrop.Outcome.Fan) {
                fans++;
            } else if (o == AuctionDrop.Outcome.Auction) {
                auction++;
                assertGe(amounts[i], price, "every auction winner bid at least the price");
            } else if (amounts[i] > highestLoser) {
                highestLoser = amounts[i];
            }
        }
        assertEq(fans, 2);
        assertEq(auction, 2);
        assertEq(price, highestLoser, "price = highest bid among auction losers");
    }

    // ─────────────── bidding rules ───────────────

    function test_OneBidPerNullifier() public {
        _deploy(3, 0);
        address a = makeAddr("a");
        address b = makeAddr("b");
        _swap(a, 1 ether, _hookData(a, 1 ether, 42, verifierKey));

        // Same person, second wallet.
        bytes memory again = _hookData(b, 1 ether, 42, verifierKey);
        vm.deal(b, 1 ether);
        vm.expectRevert(_hookError(IHooks.beforeSwap.selector, AuctionDrop.NullifierUsed.selector));
        vm.prank(b, b);
        swapRouter.swap{value: 1 ether}(
            poolKey,
            SwapParams(true, -1 ether, MIN_PRICE_LIMIT),
            PoolSwapTest.TestSettings(false, false),
            again
        );

        // Same wallet, second bid.
        bytes memory twice = _hookData(a, 1 ether, 43, verifierKey);
        vm.deal(a, 1 ether);
        vm.expectRevert(_hookError(IHooks.beforeSwap.selector, AuctionDrop.AlreadyBid.selector));
        vm.prank(a, a);
        swapRouter.swap{value: 1 ether}(
            poolKey, SwapParams(true, -1 ether, MIN_PRICE_LIMIT), PoolSwapTest.TestSettings(false, false), twice
        );
    }

    function test_VoucherChecks() public {
        _deploy(3, 0);
        address a = makeAddr("a");
        (, uint256 wrongKey) = makeAddrAndKey("not-verifier");
        SwapParams memory p = SwapParams(true, -1 ether, MIN_PRICE_LIMIT);
        PoolSwapTest.TestSettings memory t = PoolSwapTest.TestSettings(false, false);
        vm.deal(a, 10 ether);

        bytes memory forged = _hookData(a, 1 ether, 1, wrongKey);
        vm.expectRevert(_hookError(IHooks.beforeSwap.selector, AuctionDrop.BadSignature.selector));
        vm.prank(a, a);
        swapRouter.swap{value: 1 ether}(poolKey, p, t, forged);

        // A voucher copied from someone else's pending bid can't be submitted by another wallet.
        bytes memory copied = _hookData(a, 1 ether, 1, verifierKey);
        address thief = makeAddr("thief");
        vm.deal(thief, 1 ether);
        vm.expectRevert(_hookError(IHooks.beforeSwap.selector, AuctionDrop.NotBuyer.selector));
        vm.prank(thief, thief);
        swapRouter.swap{value: 1 ether}(poolKey, p, t, copied);

        vm.warp(block.timestamp + 16 minutes);
        vm.expectRevert(_hookError(IHooks.beforeSwap.selector, AuctionDrop.VoucherExpired.selector));
        vm.prank(a, a);
        swapRouter.swap{value: 1 ether}(poolKey, p, t, copied);
    }

    function test_OrdinarySwapsAndLiquidityBlocked() public {
        _deploy(3, 0);
        address a = makeAddr("a");
        vm.deal(a, 10 ether);
        PoolSwapTest.TestSettings memory t = PoolSwapTest.TestSettings(false, false);

        // A plain swap with no bid attached.
        vm.expectRevert();
        vm.prank(a, a);
        swapRouter.swap{value: 1 ether}(poolKey, SwapParams(true, -1 ether, MIN_PRICE_LIMIT), t, "");

        // Exact output, and the other direction.
        bytes memory hd = _hookData(a, 1 ether, 1, verifierKey);
        vm.expectRevert(_hookError(IHooks.beforeSwap.selector, AuctionDrop.OnlyBids.selector));
        vm.prank(a, a);
        swapRouter.swap{value: 1 ether}(poolKey, SwapParams(true, 1 ether, MIN_PRICE_LIMIT), t, hd);
        vm.expectRevert(_hookError(IHooks.beforeSwap.selector, AuctionDrop.OnlyBids.selector));
        vm.prank(a, a);
        swapRouter.swap(poolKey, SwapParams(false, -1 ether, MAX_PRICE_LIMIT), t, hd);

        // No liquidity.
        vm.expectRevert(_hookError(IHooks.beforeAddLiquidity.selector, AuctionDrop.LiquidityDisabled.selector));
        modifyLiquidityRouter.modifyLiquidity(poolKey, ModifyLiquidityParams(-10, 10, 1e18, 0), "");

        // No second pool on this hook.
        PoolKey memory other = PoolKey(poolKey.currency0, poolKey.currency1, 3000, 60, poolKey.hooks);
        vm.expectRevert(_hookError(IHooks.beforeInitialize.selector, AuctionDrop.PoolAlreadyInitialized.selector));
        vm.prank(maker);
        manager.initialize(other, SQRT_PRICE_1_1);

        // No bids after bidding closes.
        vm.prank(maker);
        hook.closeBidding();
        vm.expectRevert(_hookError(IHooks.beforeSwap.selector, AuctionDrop.WrongPhase.selector));
        vm.prank(a, a);
        swapRouter.swap{value: 1 ether}(poolKey, SwapParams(true, -1 ether, MIN_PRICE_LIMIT), t, hd);
    }

    function test_OnlyMakerOpensPool() public {
        _deploy(3, 0);
        // _deploy's pool is the maker's; a stranger can't open one on a fresh hook either.
        AuctionDrop.Config memory c = AuctionDrop.Config(maker, verifier, DROP_ID, 3, 0, RESERVE, SPREAD, MIN_REVEAL, saleEnd);
        address at = address(FLAGS | (uint160(999) << 144));
        deployCodeTo("AuctionDrop.sol:AuctionDrop", abi.encode(manager, c), at);
        PoolKey memory k = PoolKey(Currency.wrap(address(0)), Currency.wrap(at), 0, 1, IHooks(at));
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                at,
                IHooks.beforeInitialize.selector,
                abi.encodeWithSelector(AuctionDrop.NotMaker.selector),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
        manager.initialize(k, SQRT_PRICE_1_1);
    }

    // ─────────────── phases ───────────────

    function test_MakerCannotSettleBeforeMinRevealTime() public {
        _deploy(3, 0);
        _bid(makeAddr("a"), 2 ether);

        vm.expectRevert(AuctionDrop.NotMaker.selector);
        hook.closeBidding();

        vm.prank(maker);
        hook.closeBidding();
        vm.warp(block.timestamp + MIN_REVEAL - 1);
        vm.prank(maker);
        vm.expectRevert(AuctionDrop.RevealTooShort.selector);
        hook.settle();

        vm.warp(block.timestamp + 1);
        vm.expectRevert(AuctionDrop.NotMaker.selector);
        hook.settle();
        vm.prank(maker);
        hook.settle();
    }

    function test_RevealMustMatchCommitment() public {
        _deploy(3, 0);
        address a = makeAddr("a");
        _bid(a, 2 ether, 3 ether);
        vm.prank(maker);
        hook.closeBidding();

        vm.prank(a);
        vm.expectRevert(AuctionDrop.BadReveal.selector);
        hook.reveal(1 ether, _secret(a)); // wrong amount
        vm.prank(a);
        vm.expectRevert(AuctionDrop.BadReveal.selector);
        hook.reveal(2 ether, bytes32(0)); // wrong secret

        _reveal(a, 2 ether);
        vm.prank(a);
        vm.expectRevert(AuctionDrop.AlreadyRevealed.selector);
        hook.reveal(2 ether, _secret(a));
    }

    function test_BidAboveDepositCannotBeRevealed() public {
        _deploy(3, 0);
        address a = makeAddr("a");
        _bid(a, 5 ether, 1 ether);
        vm.prank(maker);
        hook.closeBidding();
        vm.prank(a);
        vm.expectRevert(AuctionDrop.BadReveal.selector);
        hook.reveal(5 ether, _secret(a));
    }

    function test_UnrevealedBidForfeits() public {
        _deploy(3, 0);
        address a = makeAddr("a");
        address b = makeAddr("b");
        _bid(a, 2 ether);
        _bid(b, 3 ether);
        vm.prank(maker);
        hook.closeBidding();
        _reveal(b, 3 ether); // a never reveals
        vm.warp(block.timestamp + MIN_REVEAL);
        vm.prank(maker);
        hook.settle();

        vm.prank(a);
        vm.expectRevert(AuctionDrop.NothingToClaim.selector);
        hook.claim();
        assertEq(hook.makerFunds(), RESERVE + 2 ether, "b pays the reserve; a's deposit goes to the maker");
    }

    // ─────────────── money ───────────────

    function test_RefundsAreExact() public {
        _deploy(2, 0);
        address[] memory who = new address[](3);
        uint256[] memory amounts = new uint256[](3);
        (amounts[0], amounts[1], amounts[2]) = (5 ether, 2 ether, 4 ether);
        uint256[3] memory deposits = [uint256(6 ether), 2.5 ether, 4 ether];
        for (uint256 i; i < 3; i++) {
            who[i] = makeAddr(string(abi.encode("r", i)));
            _bid(who[i], amounts[i], deposits[i]);
        }
        _closeRevealSettle(who, amounts);

        for (uint256 i; i < 3; i++) {
            vm.prank(who[i]);
            hook.claim();
        }
        assertEq(who[0].balance, 6 ether - 2 ether, "winner: deposit minus the clearing price");
        assertEq(who[2].balance, 4 ether - 2 ether);
        assertEq(who[1].balance, 2.5 ether, "loser: whole deposit");
        assertEq(hook.balanceOf(who[0]), 1);
        assertEq(hook.balanceOf(who[1]), 0);

        vm.prank(who[0]);
        vm.expectRevert(AuctionDrop.NothingToClaim.selector);
        hook.claim();
    }

    function test_SellBackPaysPricePaidMinusSpreadAndStaysSolvent() public {
        _deploy(3, 1);
        address[] memory who = _run(_amounts(5, 2, 4, 3, 6));
        uint256 price = hook.clearingPrice();

        for (uint256 i; i < who.length; i++) {
            vm.prank(who[i]);
            hook.claim();
        }
        // Maker takes everything above the buy-back liability, before anyone sells back.
        vm.prank(maker);
        hook.withdraw();
        assertGe(_claims(), hook.liability());

        for (uint256 i; i < who.length; i++) {
            if (hook.balanceOf(who[i]) == 0) continue;
            uint256 tokenId = _tokenOf(who[i]);
            uint256 paid = hook.paidFor(tokenId);
            assertTrue(paid == RESERVE || paid == price);
            uint256 before = who[i].balance;
            vm.prank(who[i]);
            hook.sellBack(tokenId);
            assertEq(who[i].balance - before, paid * (10_000 - SPREAD) / 10_000);
            assertGe(_claims(), hook.makerFunds(), "every sell-back is paid out of what's held");
        }
        assertEq(hook.liability(), 0);

        vm.warp(saleEnd);
        vm.prank(maker);
        hook.withdraw();
        assertEq(_claims(), 0, "every wei accounted for");
    }

    function test_SellBackClosesAtSaleEnd() public {
        _deploy(1, 0);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 2 ether;
        address[] memory who = _run(amounts);
        vm.prank(who[0]);
        hook.claim();
        vm.warp(saleEnd);
        vm.prank(who[0]);
        vm.expectRevert(AuctionDrop.SaleClosed.selector);
        hook.sellBack(1);
    }

    /// Random bids, deposits and reveals: uniform pricing holds, and after every claim, sell-back
    /// and withdrawal the hook holds at least what it owes.
    function testFuzz_RandomAuctionStaysSolvent(uint256 seed, uint8 count, uint8 supply, uint8 fans) public {
        uint256 n = bound(count, 1, 12);
        uint256 s = bound(supply, 1, 8);
        _deploy(s, bound(fans, 0, s));
        vm.prevrandao(bytes32(seed));

        address[] memory who = new address[](n);
        uint256[] memory amounts = new uint256[](n);
        bool[] memory revealed = new bool[](n);
        for (uint256 i; i < n; i++) {
            who[i] = makeAddr(string(abi.encode("f", i)));
            amounts[i] = bound(uint256(keccak256(abi.encode(seed, i))), 0.1 ether, 10 ether);
            _bid(who[i], amounts[i], amounts[i] + (seed >> i) % 1 ether);
            revealed[i] = (seed >> (i + 100)) % 5 != 0; // ~1 in 5 never reveals
        }
        vm.prank(maker);
        hook.closeBidding();
        for (uint256 i; i < n; i++) {
            if (revealed[i]) _reveal(who[i], amounts[i]);
        }
        vm.warp(block.timestamp + MIN_REVEAL);
        vm.prank(maker);
        hook.settle();

        uint256 price = hook.clearingPrice();
        assertLe(hook.fanWinners() + hook.auctionWinners(), s);
        uint256 owed = hook.makerFunds();
        for (uint256 i; i < n; i++) {
            AuctionDrop.Outcome o = _outcome(who[i]);
            if (o == AuctionDrop.Outcome.Auction) assertGe(amounts[i], price);
            if (o != AuctionDrop.Outcome.None) assertGe(amounts[i], RESERVE);
            (, uint128 deposit,,,,) = hook.bids(who[i]);
            if (revealed[i]) owed += deposit - (o == AuctionDrop.Outcome.Fan ? RESERVE : o == AuctionDrop.Outcome.Auction ? price : 0);
        }
        assertEq(_claims(), owed, "held = maker's share + every refund");

        for (uint256 i; i < n; i++) {
            if (!revealed[i]) continue;
            vm.prank(who[i]);
            hook.claim();
            if ((seed >> (i + 200)) % 2 == 0) {
                vm.prank(maker);
                hook.withdraw();
            }
            assertGe(_claims(), hook.liability());
        }
        for (uint256 i; i < n; i++) {
            if (hook.balanceOf(who[i]) == 0 || (seed >> (i + 150)) % 3 == 0) continue;
            uint256 tokenId = _tokenOf(who[i]); // before the prank: the lookup makes calls
            vm.prank(who[i]);
            hook.sellBack(tokenId);
            assertGe(_claims(), hook.makerFunds());
        }
        vm.warp(saleEnd);
        vm.prank(maker);
        hook.withdraw();
        assertEq(_claims(), 0);
    }

    function _tokenOf(address who) internal view returns (uint256 id) {
        for (id = 1; id <= hook.fanWinners() + hook.auctionWinners(); id++) {
            if (hook.paidFor(id) != 0 && _ownerOrZero(id) == who) return id;
        }
        revert("no token");
    }

    function _ownerOrZero(uint256 id) internal view returns (address) {
        try hook.ownerOf(id) returns (address o) {
            return o;
        } catch {
            return address(0);
        }
    }
}
