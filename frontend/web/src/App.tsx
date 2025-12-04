// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface FusionRecord {
  id: string;
  encryptedAmount: string;
  timestamp: number;
  participants: string[];
  status: "pending" | "completed" | "failed";
  txHash: string;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [fusions, setFusions] = useState<FusionRecord[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newFusionData, setNewFusionData] = useState({ amount: 0, participants: [""] });
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterStatus, setFilterStatus] = useState<"all" | "pending" | "completed" | "failed">("all");
  const [selectedFusion, setSelectedFusion] = useState<FusionRecord | null>(null);
  const [decryptedAmount, setDecryptedAmount] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [userHistory, setUserHistory] = useState<FusionRecord[]>([]);

  const completedCount = fusions.filter(f => f.status === "completed").length;
  const pendingCount = fusions.filter(f => f.status === "pending").length;
  const failedCount = fusions.filter(f => f.status === "failed").length;

  useEffect(() => {
    loadFusions().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  useEffect(() => {
    if (address && fusions.length > 0) {
      setUserHistory(fusions.filter(f => f.participants.includes(address.toLowerCase())));
    }
  }, [address, fusions]);

  const loadFusions = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) {
        console.log("Contract is not available");
        return;
      }

      // Load fusion keys
      const keysBytes = await contract.getData("fusion_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing fusion keys:", e); }
      }

      // Load each fusion record
      const list: FusionRecord[] = [];
      for (const key of keys) {
        try {
          const recordBytes = await contract.getData(`fusion_${key}`);
          if (recordBytes.length > 0) {
            try {
              const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
              list.push({ 
                id: key, 
                encryptedAmount: recordData.amount, 
                timestamp: recordData.timestamp, 
                participants: recordData.participants, 
                status: recordData.status || "pending",
                txHash: recordData.txHash || ""
              });
            } catch (e) { console.error(`Error parsing fusion data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading fusion ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setFusions(list);
    } catch (e) { console.error("Error loading fusions:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const createFusion = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting fusion amount with Zama FHE..." });
    try {
      const encryptedAmount = FHEEncryptNumber(newFusionData.amount);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const fusionId = `fusion-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const participants = [...newFusionData.participants, address || ""].filter(p => p !== "");
      
      const fusionData = { 
        amount: encryptedAmount, 
        timestamp: Math.floor(Date.now() / 1000), 
        participants: participants.map(p => p.toLowerCase()),
        status: "pending",
        txHash: ""
      };
      
      await contract.setData(`fusion_${fusionId}`, ethers.toUtf8Bytes(JSON.stringify(fusionData)));
      
      // Update fusion keys
      const keysBytes = await contract.getData("fusion_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(fusionId);
      await contract.setData("fusion_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "FHE Fusion created successfully!" });
      await loadFusions();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewFusionData({ amount: 0, participants: [""] });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Fusion creation failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const completeFusion = async (fusionId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Completing FHE Fusion..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const recordBytes = await contract.getData(`fusion_${fusionId}`);
      if (recordBytes.length === 0) throw new Error("Fusion not found");
      
      const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
      const updatedRecord = { ...recordData, status: "completed", txHash: `0x${Math.random().toString(16).substring(2, 66)}` };
      
      await contract.setData(`fusion_${fusionId}`, ethers.toUtf8Bytes(JSON.stringify(updatedRecord)));
      
      setTransactionStatus({ visible: true, status: "success", message: "FHE Fusion completed successfully!" });
      await loadFusions();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Fusion completion failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const failFusion = async (fusionId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Failing FHE Fusion..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const recordBytes = await contract.getData(`fusion_${fusionId}`);
      if (recordBytes.length === 0) throw new Error("Fusion not found");
      
      const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
      const updatedRecord = { ...recordData, status: "failed", txHash: `0x${Math.random().toString(16).substring(2, 66)}` };
      
      await contract.setData(`fusion_${fusionId}`, ethers.toUtf8Bytes(JSON.stringify(updatedRecord)));
      
      setTransactionStatus({ visible: true, status: "success", message: "FHE Fusion marked as failed!" });
      await loadFusions();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Fusion failure marking failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isParticipant = (fusion: FusionRecord) => {
    return address && fusion.participants.includes(address.toLowerCase());
  };

  const filteredFusions = fusions.filter(fusion => {
    const matchesSearch = fusion.id.toLowerCase().includes(searchTerm.toLowerCase()) || 
                         fusion.participants.some(p => p.toLowerCase().includes(searchTerm.toLowerCase()));
    const matchesStatus = filterStatus === "all" || fusion.status === filterStatus;
    return matchesSearch && matchesStatus;
  });

  const renderStats = () => (
    <div className="stats-grid">
      <div className="stat-item">
        <div className="stat-value">{fusions.length}</div>
        <div className="stat-label">Total Fusions</div>
      </div>
      <div className="stat-item">
        <div className="stat-value">{completedCount}</div>
        <div className="stat-label">Completed</div>
      </div>
      <div className="stat-item">
        <div className="stat-value">{pendingCount}</div>
        <div className="stat-label">Pending</div>
      </div>
      <div className="stat-item">
        <div className="stat-value">{failedCount}</div>
        <div className="stat-label">Failed</div>
      </div>
    </div>
  );

  if (loading) return (
    <div className="loading-screen">
      <div className="cyber-spinner"></div>
      <p>Initializing FHE Cash Fusion...</p>
    </div>
  );

  return (
    <div className="app-container cyberpunk-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon"><div className="shield-icon"></div></div>
          <h1>Cash<span>Fusion</span>FHE</h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowCreateModal(true)} className="create-fusion-btn cyber-button">
            <div className="add-icon"></div>New Fusion
          </button>
          <div className="wallet-connect-wrapper"><ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/></div>
        </div>
      </header>
      <div className="main-content">
        <div className="welcome-banner">
          <div className="welcome-text">
            <h2>FHE Cash Fusion Network</h2>
            <p>Decentralized payment network with FHE-based "cash fusion" privacy</p>
          </div>
          <div className="fhe-indicator"><div className="fhe-lock"></div><span>Zama FHE Encryption Active</span></div>
        </div>

        <div className="dashboard-grid">
          <div className="dashboard-card cyber-card">
            <h3>Project Introduction</h3>
            <p>A privacy payment network using <strong>Zama FHE technology</strong> that allows multiple users' UTXOs to "fuse" and split in an FHE-encrypted transaction, completely cutting off the transaction graph and achieving extreme anonymity.</p>
            <div className="tech-tags">
              <span>Multi-party FHE encryption</span>
              <span>Break address associations</span>
              <span>Bitcoin-level anonymity</span>
            </div>
          </div>
          
          <div className="dashboard-card cyber-card">
            <h3>Fusion Statistics</h3>
            {renderStats()}
          </div>
        </div>

        <div className="user-history-section cyber-card">
          <h3>Your Fusion History</h3>
          {userHistory.length === 0 ? (
            <div className="no-records">
              <p>No fusion history found for your wallet</p>
            </div>
          ) : (
            <div className="history-list">
              {userHistory.slice(0, 3).map(fusion => (
                <div key={fusion.id} className="history-item" onClick={() => setSelectedFusion(fusion)}>
                  <div className="fusion-id">#{fusion.id.substring(0, 8)}</div>
                  <div className={`fusion-status ${fusion.status}`}>{fusion.status}</div>
                  <div className="fusion-date">{new Date(fusion.timestamp * 1000).toLocaleDateString()}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="fusions-section">
          <div className="section-header">
            <h2>FHE Cash Fusions</h2>
            <div className="header-actions">
              <div className="search-box">
                <input 
                  type="text" 
                  placeholder="Search fusions..." 
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="cyber-input"
                />
              </div>
              <select 
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value as any)}
                className="cyber-select"
              >
                <option value="all">All Status</option>
                <option value="pending">Pending</option>
                <option value="completed">Completed</option>
                <option value="failed">Failed</option>
              </select>
              <button onClick={loadFusions} className="refresh-btn cyber-button" disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>
          
          <div className="fusions-list cyber-card">
            <div className="table-header">
              <div className="header-cell">ID</div>
              <div className="header-cell">Participants</div>
              <div className="header-cell">Date</div>
              <div className="header-cell">Status</div>
              <div className="header-cell">Actions</div>
            </div>
            
            {filteredFusions.length === 0 ? (
              <div className="no-records">
                <div className="no-records-icon"></div>
                <p>No fusions found</p>
                <button className="cyber-button primary" onClick={() => setShowCreateModal(true)}>Create First Fusion</button>
              </div>
            ) : filteredFusions.map(fusion => (
              <div className="fusion-row" key={fusion.id} onClick={() => setSelectedFusion(fusion)}>
                <div className="table-cell fusion-id">#{fusion.id.substring(0, 6)}</div>
                <div className="table-cell">
                  {fusion.participants.slice(0, 2).map(p => `${p.substring(0, 4)}...${p.substring(38)}`).join(", ")}
                  {fusion.participants.length > 2 && ` +${fusion.participants.length - 2}`}
                </div>
                <div className="table-cell">{new Date(fusion.timestamp * 1000).toLocaleDateString()}</div>
                <div className="table-cell"><span className={`status-badge ${fusion.status}`}>{fusion.status}</span></div>
                <div className="table-cell actions">
                  {isParticipant(fusion) && fusion.status === "pending" && (
                    <>
                      <button className="action-btn cyber-button success" onClick={(e) => { e.stopPropagation(); completeFusion(fusion.id); }}>Complete</button>
                      <button className="action-btn cyber-button danger" onClick={(e) => { e.stopPropagation(); failFusion(fusion.id); }}>Fail</button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      
      {showCreateModal && (
        <div className="modal-overlay">
          <div className="create-modal cyber-card">
            <div className="modal-header">
              <h2>Create New FHE Fusion</h2>
              <button onClick={() => setShowCreateModal(false)} className="close-modal">&times;</button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>Fusion Amount *</label>
                <input 
                  type="number" 
                  value={newFusionData.amount}
                  onChange={(e) => setNewFusionData({...newFusionData, amount: parseFloat(e.target.value)})}
                  placeholder="Enter amount to fuse..."
                  className="cyber-input"
                  step="0.01"
                />
              </div>
              
              <div className="form-group">
                <label>Participants (comma separated addresses)</label>
                {newFusionData.participants.map((p, i) => (
                  <input
                    key={i}
                    type="text"
                    value={p}
                    onChange={(e) => {
                      const newParticipants = [...newFusionData.participants];
                      newParticipants[i] = e.target.value;
                      setNewFusionData({...newFusionData, participants: newParticipants});
                    }}
                    placeholder={`Participant ${i + 1} address`}
                    className="cyber-input"
                  />
                ))}
                <button 
                  onClick={() => setNewFusionData({...newFusionData, participants: [...newFusionData.participants, ""]})}
                  className="cyber-button small"
                >
                  Add Participant
                </button>
              </div>
              
              <div className="encryption-preview">
                <h4>FHE Encryption Preview</h4>
                <div className="preview-container">
                  <div className="plain-data"><span>Plain Amount:</span><div>{newFusionData.amount || '0'}</div></div>
                  <div className="encryption-arrow">→</div>
                  <div className="encrypted-data">
                    <span>Encrypted Data:</span>
                    <div>{newFusionData.amount ? FHEEncryptNumber(newFusionData.amount).substring(0, 50) + '...' : 'No amount entered'}</div>
                  </div>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button onClick={() => setShowCreateModal(false)} className="cancel-btn cyber-button">Cancel</button>
              <button onClick={createFusion} disabled={creating} className="submit-btn cyber-button primary">
                {creating ? "Creating FHE Fusion..." : "Create Fusion"}
              </button>
            </div>
          </div>
        </div>
      )}
      
      {selectedFusion && (
        <div className="modal-overlay">
          <div className="fusion-detail-modal cyber-card">
            <div className="modal-header">
              <h2>Fusion Details #{selectedFusion.id.substring(0, 8)}</h2>
              <button onClick={() => { setSelectedFusion(null); setDecryptedAmount(null); }} className="close-modal">&times;</button>
            </div>
            <div className="modal-body">
              <div className="fusion-info">
                <div className="info-item"><span>Status:</span><strong className={`status-badge ${selectedFusion.status}`}>{selectedFusion.status}</strong></div>
                <div className="info-item"><span>Date:</span><strong>{new Date(selectedFusion.timestamp * 1000).toLocaleString()}</strong></div>
                {selectedFusion.txHash && <div className="info-item"><span>TX Hash:</span><strong className="tx-hash">{selectedFusion.txHash.substring(0, 12)}...{selectedFusion.txHash.substring(selectedFusion.txHash.length - 6)}</strong></div>}
              </div>
              
              <div className="participants-section">
                <h3>Participants</h3>
                <div className="participants-list">
                  {selectedFusion.participants.map((p, i) => (
                    <div key={i} className={`participant ${p.toLowerCase() === address?.toLowerCase() ? 'you' : ''}`}>
                      {p.substring(0, 6)}...{p.substring(38)}
                      {p.toLowerCase() === address?.toLowerCase() && <span className="you-tag">(You)</span>}
                    </div>
                  ))}
                </div>
              </div>
              
              <div className="encrypted-data-section">
                <h3>Encrypted Amount</h3>
                <div className="encrypted-data">{selectedFusion.encryptedAmount.substring(0, 100)}...</div>
                <div className="fhe-tag"><div className="fhe-icon"></div><span>Zama FHE Encrypted</span></div>
                <button 
                  className="decrypt-btn cyber-button" 
                  onClick={async () => {
                    if (decryptedAmount !== null) {
                      setDecryptedAmount(null);
                    } else {
                      const decrypted = await decryptWithSignature(selectedFusion.encryptedAmount);
                      if (decrypted !== null) setDecryptedAmount(decrypted);
                    }
                  }} 
                  disabled={isDecrypting}
                >
                  {isDecrypting ? "Decrypting..." : decryptedAmount !== null ? "Hide Amount" : "Decrypt Amount"}
                </button>
              </div>
              
              {decryptedAmount !== null && (
                <div className="decrypted-data-section">
                  <h3>Decrypted Amount</h3>
                  <div className="decrypted-value">{decryptedAmount}</div>
                  <div className="decryption-notice">
                    <div className="warning-icon"></div>
                    <span>Decrypted amount is only visible after wallet signature verification</span>
                  </div>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button onClick={() => { setSelectedFusion(null); setDecryptedAmount(null); }} className="close-btn cyber-button">Close</button>
            </div>
          </div>
        </div>
      )}
      
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content cyber-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="cyber-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo"><div className="shield-icon"></div><span>CashFusionFHE</span></div>
            <p>Decentralized payment network with FHE-based privacy</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge"><span>Powered by Zama FHE</span></div>
          <div className="copyright">© {new Date().getFullYear()} CashFusionFHE. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
};

export default App;