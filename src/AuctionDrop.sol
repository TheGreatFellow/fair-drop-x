// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseAsyncSwap} from "@openzeppelin/uniswap-hooks/base/BaseAsyncSwap.sol";
import {BaseHook} from "@openzeppelin/uniswap-hooks/base/BaseHook.sol";
import {CurrencySettler} from "@openzeppelin/uniswap-hooks/utils/CurrencySettler.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {BeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

/// @title AuctionDrop — a limited drop sold by one sealed-bid, uniform-price auction (SPEC §8.2),
/// built as a Uniswap v4 hook.
/// @notice A bid is a swap: ETH swapped into the pool is taken whole by the hook as the bid
/// deposit (OpenZeppelin's async-swap pattern), with the sealed commitment and a World ID voucher
/// in `hookData`. The pool pairs ETH with this contract itself: its "other side" is the drop's units.
///
/// Flow: bid (swap) → maker closes bidding → reveal → maker settles (fan raffle at 定価 first, then
/// the rest to the highest bids at one price: the highest losing bid) → claim; maker withdraws.
/// No sell-back (unlike Drop.sol): winners paid the market price, so there is no resale edge to
/// compete with, and a returned unit could never be resold in a single-round auction.
contract AuctionDrop is BaseAsyncSwap, ERC721, EIP712, IUnlockCallback {
    using CurrencySettler for Currency;

    struct Config {
        address maker;
        address verifier;
        bytes32 dropId;
        uint256 supply; // N
        uint256 fanUnits; // X, raffled at the reserve price
        uint256 reservePrice; // 定価
        uint256 minRevealTime; // seconds the reveal phase stays open before the maker may settle
    }

    // Same voucher as Drop.sol, so the Phase 1 backend signs for both.
    struct Voucher {
        bytes32 dropId;
        address buyer;
        uint256 nullifierHash;
        uint256 deadline;
    }

    enum Phase {
        Bidding,
        Reveal,
        Settled
    }

    enum Outcome {
        None,
        Fan,
        Auction
    }

    struct Bid {
        bytes32 commitment;
        uint128 deposit;
        uint128 amount; // set on reveal
        bool revealed;
        bool claimed;
        Outcome outcome;
    }

    bytes32 public constant VOUCHER_TYPEHASH =
        keccak256("Voucher(bytes32 dropId,address buyer,uint256 nullifierHash,uint256 deadline)");
    Currency private constant ETH = CurrencyLibrary.ADDRESS_ZERO;

    address public immutable maker;
    address public immutable verifier;
    bytes32 public immutable dropId;
    uint256 public immutable supply;
    uint256 public immutable fanUnits;
    uint256 public immutable reservePrice;
    uint256 public immutable minRevealTime;

    Phase public phase;
    bool public poolInitialized;
    uint256 public revealStart;
    uint256 public clearingPrice; // what auction winners pay; set at settlement
    uint256 public fanWinners;
    uint256 public auctionWinners;

    address[] public bidders;
    mapping(address => Bid) public bids;
    mapping(uint256 => bool) public nullifierUsed;
    mapping(uint256 => uint256) public paidFor; // tokenId => price its winner paid (fulfilment)

    uint256 public makerFunds; // owed to the maker: sale proceeds + forfeited deposits
    uint256 private nextTokenId;

    event BidPlaced(address indexed bidder, uint256 nullifierHash, uint256 deposit);
    event BiddingClosed(uint256 revealStart);
    event BidRevealed(address indexed bidder, uint256 amount);
    event Settled(uint256 clearingPrice, uint256 fanWinners, uint256 auctionWinners);
    event Claimed(address indexed bidder, Outcome outcome, uint256 tokenId, uint256 refund);
    event Withdrawn(uint256 amount);

    error BadConfig();
    error PoolAlreadyInitialized();
    error WrongPool();
    error LiquidityDisabled();
    error OnlyBids();
    error WrongPhase();
    error NotMaker();
    error BadVoucher();
    error VoucherExpired();
    error BadSignature();
    error NotBuyer();
    error NullifierUsed();
    error AlreadyBid();
    error NoBid();
    error AlreadyRevealed();
    error BadReveal();
    error RevealTooShort();
    error NothingToClaim();

    modifier onlyMaker() {
        if (msg.sender != maker) revert NotMaker();
        _;
    }

    modifier inPhase(Phase p) {
        if (phase != p) revert WrongPhase();
        _;
    }

    constructor(IPoolManager poolManager_, Config memory c)
        BaseHook(poolManager_)
        ERC721("Fair Drop Auction", "FAIRA")
        EIP712("Drop", "1")
    {
        if (c.fanUnits > c.supply || c.supply == 0) revert BadConfig();
        maker = c.maker;
        verifier = c.verifier;
        dropId = c.dropId;
        supply = c.supply;
        fanUnits = c.fanUnits;
        reservePrice = c.reservePrice;
        minRevealTime = c.minRevealTime;
    }

    // ───────────────────────────── Uniswap v4 hook ─────────────────────────────

    function getHookPermissions() public pure override returns (Hooks.Permissions memory p) {
        p = super.getHookPermissions(); // beforeSwap + beforeSwapReturnDelta
        p.beforeInitialize = true;
        p.beforeAddLiquidity = true;
    }

    /// One pool per drop, ETH against this contract, opened by the maker.
    function _beforeInitialize(address sender, PoolKey calldata key, uint160) internal override returns (bytes4) {
        if (poolInitialized) revert PoolAlreadyInitialized();
        if (sender != maker) revert NotMaker();
        if (!key.currency0.isAddressZero() || Currency.unwrap(key.currency1) != address(this)) revert WrongPool();
        poolInitialized = true;
        return this.beforeInitialize.selector;
    }

    /// The pool only takes bids; nobody provides liquidity.
    function _beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        internal
        pure
        override
        returns (bytes4)
    {
        revert LiquidityDisabled();
    }

    /// A bid: exact-input ETH → unit swap carrying `abi.encode(Voucher, signature, commitment)`.
    /// Everything else — the other direction, exact output, no hookData — reverts.
    function _beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (!params.zeroForOne || params.amountSpecified >= 0) revert OnlyBids();
        if (phase != Phase.Bidding) revert WrongPhase();
        (Voucher memory v, bytes memory sig, bytes32 commitment) = abi.decode(hookData, (Voucher, bytes, bytes32));

        if (v.dropId != dropId) revert BadVoucher();
        if (block.timestamp > v.deadline) revert VoucherExpired();
        if (ECDSA.recover(hashVoucher(v), sig) != verifier) revert BadSignature();
        // The swap comes through a router, so `sender` is the router, not the bidder.
        // ponytail: tx.origin binds the bid to the voucher's wallet so a copied hookData can't be
        // front-run with a 1-wei deposit; smart-contract wallets would need a signed-deposit scheme.
        if (v.buyer != tx.origin) revert NotBuyer();
        if (nullifierUsed[v.nullifierHash]) revert NullifierUsed();
        if (bids[v.buyer].commitment != 0) revert AlreadyBid();
        if (commitment == 0) revert BadReveal();

        uint256 deposit = uint256(-params.amountSpecified);
        nullifierUsed[v.nullifierHash] = true;
        bids[v.buyer] = Bid(commitment, uint128(deposit), 0, false, false, Outcome.None);
        bidders.push(v.buyer);
        emit BidPlaced(v.buyer, v.nullifierHash, deposit);

        // Takes the whole deposit as ERC-6909 claims and nets the swap to zero.
        return super._beforeSwap(sender, key, params, hookData);
    }

    // ───────────────────────────── Auction ─────────────────────────────

    /// The commitment a bidder puts in `hookData`. The deposit (≥ amount) hides the amount.
    function commitmentOf(uint256 amount, bytes32 secret, address bidder) public pure returns (bytes32) {
        return keccak256(abi.encode(amount, secret, bidder));
    }

    function closeBidding() external onlyMaker inPhase(Phase.Bidding) {
        phase = Phase.Reveal;
        revealStart = block.timestamp;
        emit BiddingClosed(block.timestamp);
    }

    function reveal(uint256 amount, bytes32 secret) external inPhase(Phase.Reveal) {
        Bid storage b = bids[msg.sender];
        if (b.commitment == 0) revert NoBid();
        if (b.revealed) revert AlreadyRevealed();
        if (commitmentOf(amount, secret, msg.sender) != b.commitment || amount > b.deposit) revert BadReveal();
        b.revealed = true;
        b.amount = uint128(amount);
        emit BidRevealed(msg.sender, amount);
    }

    /// Fan raffle first, then the auction among everyone else (SPEC §8.2). Raffle-first means a
    /// bid never changes your raffle odds, so bidding your true value stays optimal.
    /// ponytail: O(bids²) insertion sort, fine for a demo-sized drop; a sorted insert at reveal
    /// time (or offchain sort + onchain check) scales further.
    function settle() external onlyMaker inPhase(Phase.Reveal) {
        if (block.timestamp < revealStart + minRevealTime) revert RevealTooShort();
        phase = Phase.Settled;

        // Eligible = revealed at or above the reserve, by bidder index (= bid order).
        uint256 n;
        uint256[] memory pool = new uint256[](bidders.length);
        uint256 forfeits;
        for (uint256 i; i < bidders.length; i++) {
            Bid storage b = bids[bidders[i]];
            if (!b.revealed) forfeits += b.deposit;
            else if (b.amount >= reservePrice) pool[n++] = i;
        }

        // Raffle: partial Fisher–Yates; the first `fans` slots win fan units.
        // ponytail: prevrandao is biasable by the block proposer; use VRF for real stakes.
        uint256 fans = fanUnits < n ? fanUnits : n;
        uint256 seed = uint256(keccak256(abi.encode(block.prevrandao, address(this), n)));
        for (uint256 i; i < fans; i++) {
            uint256 j = i + seed % (n - i);
            (pool[i], pool[j]) = (pool[j], pool[i]);
            bids[bidders[pool[i]]].outcome = Outcome.Fan;
            seed = uint256(keccak256(abi.encode(seed)));
        }

        // Auction: sort the rest by amount desc, earlier bid first on ties.
        for (uint256 i = fans + 1; i < n; i++) {
            uint256 k = pool[i];
            uint256 j = i;
            while (j > fans && _before(k, pool[j - 1])) {
                pool[j] = pool[j - 1];
                j--;
            }
            pool[j] = k;
        }
        uint256 units = supply - fans;
        uint256 winners = n - fans < units ? n - fans : units;
        uint256 price = n - fans > units ? bids[bidders[pool[fans + units]]].amount : reservePrice;
        for (uint256 i = fans; i < fans + winners; i++) {
            bids[bidders[pool[i]]].outcome = Outcome.Auction;
        }

        clearingPrice = price;
        fanWinners = fans;
        auctionWinners = winners;
        makerFunds = fans * reservePrice + winners * price + forfeits;
        emit Settled(price, fans, winners);
    }

    /// Winners get their unit and the deposit minus the price; losers get the whole deposit back.
    /// Unrevealed bids forfeit.
    function claim() external inPhase(Phase.Settled) {
        Bid storage b = bids[msg.sender];
        if (!b.revealed || b.claimed) revert NothingToClaim();
        b.claimed = true;

        uint256 price = b.outcome == Outcome.Fan ? reservePrice : b.outcome == Outcome.Auction ? clearingPrice : 0;
        uint256 tokenId;
        if (b.outcome != Outcome.None) {
            tokenId = ++nextTokenId;
            paidFor[tokenId] = price;
            _mint(msg.sender, tokenId);
        }
        uint256 refund = b.deposit - price;
        emit Claimed(msg.sender, b.outcome, tokenId, refund);
        _pay(msg.sender, refund);
    }

    /// Everything the sale raised is the maker's as soon as it settles: refunds are owed from the
    /// bidders' own deposits, never from proceeds.
    function withdraw() external onlyMaker {
        uint256 amount = makerFunds;
        makerFunds = 0;
        emit Withdrawn(amount);
        _pay(maker, amount);
    }

    function biddersCount() external view returns (uint256) {
        return bidders.length;
    }

    function hashVoucher(Voucher memory v) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(VOUCHER_TYPEHASH, v.dropId, v.buyer, v.nullifierHash, v.deadline)));
    }

    // ───────────────────────────── Internals ─────────────────────────────

    function _before(uint256 a, uint256 b) private view returns (bool) {
        uint256 amountA = bids[bidders[a]].amount;
        uint256 amountB = bids[bidders[b]].amount;
        return amountA > amountB || (amountA == amountB && a < b);
    }

    /// Deposits sit in the PoolManager as this hook's ERC-6909 claims; paying out burns claims and
    /// takes the ETH, inside an unlock.
    function _pay(address to, uint256 amount) private {
        if (amount != 0) poolManager.unlock(abi.encode(to, amount));
    }

    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        (address to, uint256 amount) = abi.decode(data, (address, uint256));
        ETH.settle(poolManager, address(this), amount, true); // burn claims → credit
        ETH.take(poolManager, to, amount, false); // credit → ETH to `to`
        return "";
    }
}
