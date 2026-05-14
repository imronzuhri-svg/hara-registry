// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title  ContractRegistry
/// @notice Canonical registry of HaraLedger contract deployments by name + version.
///         Lets services and clients discover the currently-active address for any
///         logical contract without hardcoding addresses across the codebase.
///
///         Version semantics: callers ask for "active" version by name. Old versions
///         remain queryable for historical reads and audit.
///
///         L0 stage: 3 contracts will register here — this contract itself, plus
///         AnchorRegistry and GovernanceContract. The DID/Cert/Traceability contracts
///         land in their respective product roadmaps and will register here as they
///         deploy.
contract ContractRegistry is AccessControl {
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");

    struct Entry {
        address addr;
        uint64 version;
        uint64 registeredAt;
        bool active;
    }

    /// name => version => entry
    mapping(bytes32 => mapping(uint64 => Entry)) private _entries;
    /// name => currently-active version
    mapping(bytes32 => uint64) public activeVersion;

    event ContractRegistered(bytes32 indexed name, uint64 indexed version, address addr);
    event ActiveVersionChanged(bytes32 indexed name, uint64 indexed version, address addr);
    event ContractDeactivated(bytes32 indexed name, uint64 indexed version);

    error AlreadyRegistered(bytes32 name, uint64 version);
    error NotRegistered(bytes32 name, uint64 version);
    error ZeroAddress();

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(REGISTRAR_ROLE, admin);
    }

    /// @notice Register a new contract version. The first registration for a name
    ///         automatically becomes the active version.
    function register(bytes32 name, uint64 version, address addr)
        external
        onlyRole(REGISTRAR_ROLE)
    {
        if (addr == address(0)) revert ZeroAddress();
        if (_entries[name][version].addr != address(0)) {
            revert AlreadyRegistered(name, version);
        }

        _entries[name][version] = Entry({
            addr: addr,
            version: version,
            registeredAt: uint64(block.timestamp),
            active: true
        });

        emit ContractRegistered(name, version, addr);

        // Auto-activate the first version registered for a given name
        if (activeVersion[name] == 0) {
            activeVersion[name] = version;
            emit ActiveVersionChanged(name, version, addr);
        }
    }

    /// @notice Switch the active version for a contract name.
    function setActiveVersion(bytes32 name, uint64 version) external onlyRole(REGISTRAR_ROLE) {
        Entry memory e = _entries[name][version];
        if (e.addr == address(0)) revert NotRegistered(name, version);
        activeVersion[name] = version;
        emit ActiveVersionChanged(name, version, e.addr);
    }

    /// @notice Mark a registered version as inactive. The active pointer is unchanged.
    function deactivate(bytes32 name, uint64 version) external onlyRole(REGISTRAR_ROLE) {
        Entry storage e = _entries[name][version];
        if (e.addr == address(0)) revert NotRegistered(name, version);
        e.active = false;
        emit ContractDeactivated(name, version);
    }

    /// @notice Address of the currently-active version for a contract name.
    function getActive(bytes32 name) external view returns (address) {
        uint64 v = activeVersion[name];
        return _entries[name][v].addr;
    }

    function getEntry(bytes32 name, uint64 version) external view returns (Entry memory) {
        return _entries[name][version];
    }
}
