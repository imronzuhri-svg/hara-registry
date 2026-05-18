// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

/// @title IssuerRegistry — on-chain accreditation registry for hara-did issuers.
/// @notice Holds the canonical record of which issuer DIDs are trusted, what
///         category of credentials they're authorized to issue, and which
///         public key hash auditors should expect their VC signatures against.
///
///         Mutations (`addIssuer`, `setIssuerStatus`, `rotateIssuerKey` when
///         called by REGISTRAR_ROLE) are gated to the REGISTRAR_ROLE. The
///         intent is that the role is held by `GovernanceContract` so onboarding
///         requires an M-of-N proposal (per roadmap-v2 D2). For dev we also
///         grant the role to the deployer so test scripts can self-bootstrap.
///
///         No halal-supply-chain enumerations live here. Categories are deliberately
///         broad-domain (Government / Financial / Education / Healthcare / Employment /
///         RealEstate / Telecom / Community / Other) so the contract works for any
///         SSI vertical. Halal-specific accreditation is a layer on top — a
///         "HalalAccreditationRegistry" contract referencing this base, deferred
///         to a future vertical track.
///
///         Schema match: events mirror the names the hara-ledger indexer manual
///         §10.1 documents, so the shared indexer can pick our events up by
///         adding our address to `watched_contracts` with no schema changes.
contract IssuerRegistry {
    // ── Enums ───────────────────────────────────────────────────────────────

    /// Broad credential category. Verifiers check `isActive(issuerId, role)`
    /// to decide whether to trust a presented VC. New categories are *append-only*
    /// — never renumber existing entries (event topic hash would shift, breaking
    /// historical replays).
    enum Role {
        Other,                  // 0  — explicit "uncategorized" slot; default for safety
        Government,             // 1  — central / regional government bodies
        FinancialServices,      // 2  — banks, e-money operators, insurance
        Education,              // 3  — schools, universities, MOOCs
        Healthcare,             // 4  — hospitals, clinics, labs
        Employment,             // 5  — employers issuing employment credentials
        RealEstate,             // 6  — land/property authorities, brokers
        Telecom,                // 7  — telcos issuing SIM / KYC credentials
        Community               // 8  — community organizations, civil society
    }

    /// Lifecycle of an issuer record. Transitions: Pending → Active, Active ↔ Suspended,
    /// Active|Suspended → Revoked. Revoked is terminal.
    enum Status {
        Pending,                // 0  — addIssuer landed, awaiting first activation
        Active,                 // 1  — VCs from this issuer are trusted
        Suspended,              // 2  — temporary halt; existing VCs queryable but new ones MUST NOT be issued
        Revoked                 // 3  — permanent; all VCs from this issuer SHOULD be flagged
    }

    // ── Storage ────────────────────────────────────────────────────────────

    struct Issuer {
        Role     role;                  // category
        Status   status;                // current lifecycle state
        address  controller;            // EOA that owns the issuer's signing key
        bytes32  publicKeyHash;         // keccak256 of the issuer's signing pubkey (Ed25519 or aggregate)
        uint64   registeredAt;          // block.timestamp at addIssuer call
        uint64   updatedAt;             // most recent status/key change
        string   metadataURI;           // e.g. ipfs://... or https://issuer.example.com/.well-known/issuer.json
    }

    mapping(bytes32 => Issuer) private issuers;
    bytes32[] public issuerIds;          // enumeration for off-chain indexing / admin UI

    // ── Roles (OZ AccessControl-style, minimal in-tree impl) ───────────────

    bytes32 public constant REGISTRAR_ROLE     = keccak256("REGISTRAR_ROLE");
    bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00;

    mapping(bytes32 => mapping(address => bool)) private roles;

    // ── Events ─────────────────────────────────────────────────────────────

    /// Event name + topic shape align with integration manual §10.1 so the
    /// shared hara-ledger indexer decodes them with zero hara-did-specific code.
    event IssuerRegistered(bytes32 indexed issuerId, uint8 role, address controller, bytes32 publicKeyHash);
    event IssuerStatusChanged(bytes32 indexed issuerId, uint8 oldStatus, uint8 newStatus);
    event IssuerKeyRotated(bytes32 indexed issuerId, bytes32 oldKeyHash, bytes32 newKeyHash);
    event IssuerMetadataUpdated(bytes32 indexed issuerId, string newURI);
    event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender);
    event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender);

    // ── Errors ─────────────────────────────────────────────────────────────

    error AlreadyExists();
    error NotFound();
    error InvalidTransition(uint8 from, uint8 to);
    error AccessDenied(bytes32 role, address caller);

    // ── Constructor ────────────────────────────────────────────────────────

    /// @param admin           Holds DEFAULT_ADMIN_ROLE; may grant/revoke REGISTRAR_ROLE.
    /// @param initialRegistrar Granted REGISTRAR_ROLE at deploy. In dev this is
    ///                         the deployer; in production it should be the
    ///                         GovernanceContract address.
    constructor(address admin, address initialRegistrar) {
        roles[DEFAULT_ADMIN_ROLE][admin] = true;
        emit RoleGranted(DEFAULT_ADMIN_ROLE, admin, msg.sender);
        if (initialRegistrar != address(0)) {
            roles[REGISTRAR_ROLE][initialRegistrar] = true;
            emit RoleGranted(REGISTRAR_ROLE, initialRegistrar, msg.sender);
        }
    }

    // ── Access control ─────────────────────────────────────────────────────

    function hasRole(bytes32 role, address account) external view returns (bool) {
        return roles[role][account];
    }

    function grantRole(bytes32 role, address account) external {
        _requireRole(DEFAULT_ADMIN_ROLE);
        if (!roles[role][account]) {
            roles[role][account] = true;
            emit RoleGranted(role, account, msg.sender);
        }
    }

    function revokeRole(bytes32 role, address account) external {
        _requireRole(DEFAULT_ADMIN_ROLE);
        if (roles[role][account]) {
            roles[role][account] = false;
            emit RoleRevoked(role, account, msg.sender);
        }
    }

    function _requireRole(bytes32 role) internal view {
        if (!roles[role][msg.sender]) revert AccessDenied(role, msg.sender);
    }

    // ── Mutators (REGISTRAR_ROLE) ──────────────────────────────────────────

    /// @notice Register a new issuer. Called by REGISTRAR_ROLE (i.e. GovernanceContract
    ///         after an M-of-N proposal lands). Idempotent on the issuerId: re-registering
    ///         the same id reverts (`AlreadyExists`).
    /// @param  issuerId       canonical id; typically keccak256(utf8(issuerDid)).
    /// @param  role           credential category from the Role enum.
    /// @param  controller     EOA controlling the issuer's signing key.
    /// @param  publicKeyHash  keccak256 of the public key (raw bytes, not multibase).
    /// @param  metadataURI    pointer to the issuer's well-known doc; may be empty.
    function addIssuer(
        bytes32 issuerId,
        Role    role,
        address controller,
        bytes32 publicKeyHash,
        string calldata metadataURI
    ) external {
        _requireRole(REGISTRAR_ROLE);
        if (issuers[issuerId].registeredAt != 0) revert AlreadyExists();
        issuers[issuerId] = Issuer({
            role:           role,
            status:         Status.Active,            // straight to Active — the proposal IS the approval
            controller:     controller,
            publicKeyHash:  publicKeyHash,
            registeredAt:   uint64(block.timestamp),
            updatedAt:      uint64(block.timestamp),
            metadataURI:    metadataURI
        });
        issuerIds.push(issuerId);
        emit IssuerRegistered(issuerId, uint8(role), controller, publicKeyHash);
        if (bytes(metadataURI).length != 0) {
            emit IssuerMetadataUpdated(issuerId, metadataURI);
        }
    }

    /// @notice Change an issuer's status. REGISTRAR_ROLE only — even the
    ///         controller cannot self-revoke (governance is the only off-ramp).
    function setIssuerStatus(bytes32 issuerId, Status newStatus) external {
        _requireRole(REGISTRAR_ROLE);
        Issuer storage i = issuers[issuerId];
        if (i.registeredAt == 0) revert NotFound();
        Status oldStatus = i.status;
        if (!_isValidTransition(oldStatus, newStatus)) {
            revert InvalidTransition(uint8(oldStatus), uint8(newStatus));
        }
        i.status = newStatus;
        i.updatedAt = uint64(block.timestamp);
        emit IssuerStatusChanged(issuerId, uint8(oldStatus), uint8(newStatus));
    }

    /// @notice Update the issuer's metadata URI. REGISTRAR_ROLE only.
    function setIssuerMetadata(bytes32 issuerId, string calldata newURI) external {
        _requireRole(REGISTRAR_ROLE);
        Issuer storage i = issuers[issuerId];
        if (i.registeredAt == 0) revert NotFound();
        i.metadataURI = newURI;
        i.updatedAt = uint64(block.timestamp);
        emit IssuerMetadataUpdated(issuerId, newURI);
    }

    /// @notice Rotate the issuer's signing key hash. Callable by either:
    ///         - the controller (operational rotation; the new keypair has
    ///           been generated and committed off-chain), or
    ///         - REGISTRAR_ROLE (governance-mediated emergency rotation).
    function rotateIssuerKey(bytes32 issuerId, bytes32 newKeyHash) external {
        Issuer storage i = issuers[issuerId];
        if (i.registeredAt == 0) revert NotFound();
        bool isController = msg.sender == i.controller;
        bool isRegistrar  = roles[REGISTRAR_ROLE][msg.sender];
        if (!isController && !isRegistrar) {
            revert AccessDenied(isController ? bytes32(0) : REGISTRAR_ROLE, msg.sender);
        }
        bytes32 oldKey = i.publicKeyHash;
        i.publicKeyHash = newKeyHash;
        i.updatedAt = uint64(block.timestamp);
        emit IssuerKeyRotated(issuerId, oldKey, newKeyHash);
    }

    // ── Views ──────────────────────────────────────────────────────────────

    function getIssuer(bytes32 issuerId) external view returns (Issuer memory) {
        return issuers[issuerId];
    }

    function isActive(bytes32 issuerId) external view returns (bool) {
        return issuers[issuerId].status == Status.Active;
    }

    function issuerCount() external view returns (uint256) {
        return issuerIds.length;
    }

    function issuerAt(uint256 index) external view returns (bytes32) {
        return issuerIds[index];
    }

    // ── Internal ───────────────────────────────────────────────────────────

    /// Transition validity per the class comment. Encoded as a pure function so
    /// the table is auditable in one place.
    function _isValidTransition(Status from, Status to) internal pure returns (bool) {
        if (from == to) return false;                          // no self-loops
        if (from == Status.Revoked) return false;              // terminal
        if (from == Status.Pending  && to == Status.Active)     return true;
        if (from == Status.Pending  && to == Status.Revoked)    return true;
        if (from == Status.Active   && to == Status.Suspended)  return true;
        if (from == Status.Active   && to == Status.Revoked)    return true;
        if (from == Status.Suspended && to == Status.Active)    return true;
        if (from == Status.Suspended && to == Status.Revoked)   return true;
        return false;
    }
}
