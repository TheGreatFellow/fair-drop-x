// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @title Drop — fair-price limited-edition drop (SPEC §6.1)
/// @notice The first `flatUnits` units sell at `basePrice` (the normal 定価). After that the
///         price rises along a curve, and steeply over the last units so the drop rarely fully
///         sells out. While the curve still has units, nobody rationally pays more elsewhere.
contract Drop is ERC721 {
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

    error BadConfig();

    constructor(string memory name_, string memory symbol_, Config memory c) ERC721(name_, symbol_) {
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
}
