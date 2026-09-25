// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title Drop — fair-price limited-edition drop (SPEC §6.1)
/// @notice The first `flatUnits` units sell at `basePrice` (the normal 定価). After that the
///         price rises along a curve, and steeply over the last units so the drop rarely fully
///         sells out. While the curve still has units, nobody rationally pays more elsewhere.
///
///         One unit per verified human: the backend verifies a World ID proof and signs an
///         EIP-712 voucher carrying the nullifier, which this contract also records so the limit
///         does not rest on the backend alone.
///
///         Holders can sell back at the current curve price minus `spreadBps`, which burns the
///         unit and lowers the price for the next buyer. The spread sits below Mercari's ~10%
///         seller fee, so selling back beats reselling.
contract Drop is ERC721, EIP712 {
    struct Config {
        address maker;
        address verifier;
        bytes32 dropId;
        uint256 supply;
        uint256 basePrice;
        uint256 flatUnits;
        uint256 slope;
        uint256 steepStart;
        uint256 steepSlope;
        uint256 spreadBps;
        uint256 saleEnd;
    }

    struct Voucher {
        bytes32 dropId;
        address buyer;
        uint256 nullifierHash;
        uint256 deadline;
    }

    bytes32 private constant VOUCHER_TYPEHASH =
        keccak256("Voucher(bytes32 dropId,address buyer,uint256 nullifierHash,uint256 deadline)");

    uint256 private constant BPS = 10_000;

    address public immutable maker;
    address public immutable verifier;
    bytes32 public immutable dropId;
    uint256 public immutable supply;
    uint256 public immutable basePrice;
    uint256 public immutable flatUnits;
    uint256 public immutable slope;
    uint256 public immutable steepStart;
    uint256 public immutable steepSlope;
    uint256 public immutable spreadBps;
    uint256 public immutable saleEnd;

    /// @notice Units currently outstanding. This is the position on the curve.
    uint256 public sold;
    /// @notice Ids are never reused, so a sold-back edition number never comes back.
    uint256 public nextTokenId;
    /// @notice Sum of price(i) for i < sold, maintained incrementally so the buy-back liability
    ///         never needs a loop over the curve.
    uint256 public curveSum;
    mapping(uint256 nullifierHash => bool used) public nullifierUsed;

    event Bought(uint256 indexed tokenId, address indexed buyer, uint256 price, uint256 nullifierHash);
    event SoldBack(uint256 indexed tokenId, address indexed seller, uint256 payout);
    event Redeemed(uint256 indexed tokenId, address indexed owner);
    event Withdrawn(address indexed to, uint256 amount);

    error BadConfig();
    error SaleClosed();
    error SoldOut();
    error WrongDrop();
    error WrongBuyer();
    error VoucherExpired();
    error AlreadyPurchased();
    error BadSignature();
    error Underpaid();
    error SaleStillOpen();
    error NotOwner();
    error NotMaker();
    error NothingToWithdraw();
    error TransferFailed();

    constructor(string memory name_, string memory symbol_, Config memory c)
        ERC721(name_, symbol_)
        EIP712("Drop", "1")
    {
        // SPEC §6.1: 0 < flatUnits < steepStart <= supply, and a non-zero spread so churn is
        // never free for the seller (that spread is the maker's guaranteed income).
        if (c.flatUnits == 0 || c.flatUnits >= c.steepStart || c.steepStart > c.supply) revert BadConfig();
        if (c.spreadBps == 0 || c.spreadBps >= BPS) revert BadConfig();
        if (c.basePrice == 0 || c.saleEnd <= block.timestamp) revert BadConfig();
        if (c.maker == address(0) || c.verifier == address(0)) revert BadConfig();

        maker = c.maker;
        verifier = c.verifier;
        dropId = c.dropId;
        supply = c.supply;
        basePrice = c.basePrice;
        flatUnits = c.flatUnits;
        slope = c.slope;
        steepStart = c.steepStart;
        steepSlope = c.steepSlope;
        spreadBps = c.spreadBps;
        saleEnd = c.saleEnd;
    }

    /// @notice Price of the unit at 0-based curve index `i`, i.e. the (i+1)th sale.
    function price(uint256 i) public view returns (uint256) {
        if (i < flatUnits) return basePrice;
        if (i < steepStart) return basePrice + slope * (i - flatUnits + 1);
        // Continues from price(steepStart - 1) == basePrice + slope * (steepStart - flatUnits).
        return basePrice + slope * (steepStart - flatUnits) + steepSlope * (i - steepStart + 1);
    }

    function currentPrice() external view returns (uint256) {
        return price(sold);
    }

    function currentSellBackPrice() external view returns (uint256) {
        return sold == 0 ? 0 : _payoutFor(sold - 1);
    }

    function unitsLeft() external view returns (uint256) {
        return supply - sold;
    }

    function flatPhaseActive() external view returns (bool) {
        return sold < flatUnits;
    }

    /// @notice The whole curve, for the price chart on the drop page.
    function curve() external view returns (uint256[] memory prices) {
        prices = new uint256[](supply);
        for (uint256 i; i < supply; ++i) {
            prices[i] = price(i);
        }
    }

    /// @notice What the contract owes if every outstanding unit were sold back right now.
    /// @dev Flooring the sum over-reserves versus flooring each payout, so this is never short.
    function liability() public view returns (uint256) {
        return curveSum * (BPS - spreadBps) / BPS;
    }

    function _payoutFor(uint256 i) internal view returns (uint256) {
        // Rounds down, in the contract's favour (SPEC §6.1 rounding invariant).
        return price(i) * (BPS - spreadBps) / BPS;
    }

    // --- core ---

    /// @notice Buy one unit, gated by a backend voucher proving a World ID verification.
    function buy(Voucher calldata v, bytes calldata sig) external payable {
        if (block.timestamp >= saleEnd) revert SaleClosed();
        if (sold >= supply) revert SoldOut();
        if (v.dropId != dropId) revert WrongDrop();
        if (v.buyer != msg.sender) revert WrongBuyer();
        if (block.timestamp > v.deadline) revert VoucherExpired();
        if (nullifierUsed[v.nullifierHash]) revert AlreadyPurchased();
        if (ECDSA.recover(hashVoucher(v), sig) != verifier) revert BadSignature();

        uint256 p = price(sold);
        if (msg.value < p) revert Underpaid();

        // Set for good: a human who later sells back still cannot buy again (SPEC §3.1).
        nullifierUsed[v.nullifierHash] = true;
        sold += 1;
        curveSum += p;

        uint256 tokenId = ++nextTokenId;
        _safeMint(msg.sender, tokenId);
        _afterMint(tokenId, msg.sender);
        emit Bought(tokenId, msg.sender, p, v.nullifierHash);

        if (msg.value > p) _send(msg.sender, msg.value - p);
    }

    /// @notice Sell a unit back to the drop at the top curve price minus the spread.
    function sellBack(uint256 tokenId) external {
        if (block.timestamp >= saleEnd) revert SaleClosed();
        if (ownerOf(tokenId) != msg.sender) revert NotOwner();

        _beforeBurn(tokenId);
        _burn(tokenId);

        sold -= 1;
        uint256 p = price(sold); // the position just vacated
        curveSum -= p;
        uint256 payout = p * (BPS - spreadBps) / BPS;

        emit SoldBack(tokenId, msg.sender, payout);
        _send(msg.sender, payout);
    }

    /// @notice Burn a unit after the sale closes, to claim the physical item.
    function redeem(uint256 tokenId) external {
        if (block.timestamp < saleEnd) revert SaleStillOpen();
        if (ownerOf(tokenId) != msg.sender) revert NotOwner();

        _beforeBurn(tokenId);
        _burn(tokenId);
        // `sold` is deliberately left alone: the unit was fulfilled, not returned to the drop.
        emit Redeemed(tokenId, msg.sender);
    }

    /// @notice While the sale is open the maker can only take what is above the buy-back
    ///         liability, so a sell-back cascade can never find the contract short (SPEC §6.4).
    function withdraw() external {
        if (msg.sender != maker) revert NotMaker();

        uint256 balance = address(this).balance;
        uint256 amount = block.timestamp >= saleEnd ? balance : balance - liability();
        if (amount == 0) revert NothingToWithdraw();

        emit Withdrawn(maker, amount);
        _send(maker, amount);
    }

    function withdrawable() external view returns (uint256) {
        uint256 balance = address(this).balance;
        if (block.timestamp >= saleEnd) return balance;
        uint256 owed = liability();
        return balance > owed ? balance - owed : 0;
    }

    // --- Phase 2 (ENS subnames) hooks in here without touching buy/sellBack ---

    function _afterMint(uint256 tokenId, address to) internal virtual {}

    function _beforeBurn(uint256 tokenId) internal virtual {}

    // --- internals ---

    function hashVoucher(Voucher calldata v) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(VOUCHER_TYPEHASH, v.dropId, v.buyer, v.nullifierHash, v.deadline)));
    }

    function _send(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
