pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract CashFusionFhe is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;
    uint256 public cooldownSeconds;
    bool public paused;
    uint256 public currentBatchId;
    bool public batchOpen;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    struct Utxo {
        euint32 amount;
        euint32 ownerKey;
    }
    Utxo[] public encryptedUtxos;

    struct FusionResult {
        euint32 newAmount;
        euint32 newOwnerKey;
    }
    FusionResult[] public encryptedFusionResults;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event CooldownSet(uint256 oldCooldown, uint256 newCooldown);
    event Paused(address account);
    event Unpaused(address account);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event UtxoSubmitted(address indexed provider, uint256 indexed batchId, uint256 utxoIndex);
    event FusionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event FusionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256[] amounts, uint256[] ownerKeys);

    error NotOwner();
    error NotProvider();
    error PausedState();
    error CooldownActive();
    error BatchNotOpen();
    error InvalidBatchState();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();
    error NotInitialized();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert PausedState();
        _;
    }

    modifier checkSubmissionCooldown() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier checkDecryptionCooldown() {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        cooldownSeconds = 10; // Default cooldown
        emit ProviderAdded(owner);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function setCooldown(uint256 newCooldownSeconds) external onlyOwner {
        uint256 oldCooldown = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSet(oldCooldown, newCooldownSeconds);
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function openBatch() external onlyOwner whenNotPaused {
        if (batchOpen) revert InvalidBatchState();
        currentBatchId++;
        batchOpen = true;
        encryptedUtxos = new Utxo[](0); // Reset UTXOs for the new batch
        emit BatchOpened(currentBatchId);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        if (!batchOpen) revert InvalidBatchState();
        batchOpen = false;
        emit BatchClosed(currentBatchId);
    }

    function submitUtxo(euint32 encryptedAmount, euint32 encryptedOwnerKey) external onlyProvider whenNotPaused checkSubmissionCooldown {
        if (!batchOpen) revert BatchNotOpen();
        _initIfNeeded(encryptedAmount);
        _initIfNeeded(encryptedOwnerKey);

        lastSubmissionTime[msg.sender] = block.timestamp;
        encryptedUtxos.push(Utxo(encryptedAmount, encryptedOwnerKey));
        emit UtxoSubmitted(msg.sender, currentBatchId, encryptedUtxos.length - 1);
    }

    function _initIfNeeded(euint32 val) internal {
        if (!val.isInitialized()) {
            revert NotInitialized();
        }
    }

    function _initIfNeeded(ebool val) internal {
        if (!val.isInitialized()) {
            revert NotInitialized();
        }
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function requestFusion() external onlyProvider whenNotPaused checkDecryptionCooldown {
        if (encryptedUtxos.length == 0) revert InvalidBatchState(); // Need UTXOs to fuse
        if (batchOpen) revert InvalidBatchState(); // Batch must be closed

        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        // --- FHE Logic: Simplified Cash Fusion ---
        // This example demonstrates the FHE workflow. A real implementation would be more complex.
        // For this example, we'll "fuse" by summing amounts and using a new owner key.
        // This is a placeholder for actual privacy-preserving logic.

        euint32 totalFusedAmount = FHE.asEuint32(0);
        euint32 newOwnerKey = FHE.asEuint32(uint32(block.timestamp)); // Placeholder for a new key

        for (uint i = 0; i < encryptedUtxos.length; i++) {
            totalFusedAmount = totalFusedAmount.add(encryptedUtxos[i].amount);
        }
        // --- End FHE Logic ---

        encryptedFusionResults = new FusionResult[](0); // Clear previous results
        encryptedFusionResults.push(FusionResult(totalFusedAmount, newOwnerKey));

        bytes32[] memory cts = new bytes32[](2);
        cts[0] = totalFusedAmount.toBytes32();
        cts[1] = newOwnerKey.toBytes32();

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({
            batchId: currentBatchId,
            stateHash: stateHash,
            processed: false
        });

        emit FusionRequested(requestId, currentBatchId);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        // @dev Replay protection: Ensure this callback hasn't been processed for this requestId.
        if (decryptionContexts[requestId].processed) {
            revert ReplayAttempt();
        }

        // @dev State verification: Rebuild the ciphertexts from current contract state
        // and verify they match the state when decryption was requested.
        // This prevents callbacks from being processed if the underlying data has changed.
        bytes32[] memory currentCts = new bytes32[](2);
        // Rebuild ciphertexts in the exact same order as in requestFusion
        currentCts[0] = encryptedFusionResults[0].newAmount.toBytes32();
        currentCts[1] = encryptedFusionResults[0].newOwnerKey.toBytes32();

        bytes32 currentStateHash = _hashCiphertexts(currentCts);
        if (currentStateHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }

        // @dev Proof verification: Ensure the proof is valid for the given requestId and cleartexts.
        if (!FHE.checkSignatures(requestId, cleartexts, proof)) {
            revert InvalidProof();
        }

        // Decode cleartexts (must match the order of cts in requestFusion)
        uint256 amount = abi.decode(cleartexts, (uint256));
        // For simplicity, we assume ownerKey is also a uint256 here.
        // In a real scenario, it might be a different type or structure.
        uint256 ownerKey = abi.decode(cleartexts[32:], (uint256)); 

        decryptionContexts[requestId].processed = true;

        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;
        uint256[] memory ownerKeys = new uint256[](1);
        ownerKeys[0] = ownerKey;

        emit FusionCompleted(requestId, decryptionContexts[requestId].batchId, amounts, ownerKeys);
    }
}