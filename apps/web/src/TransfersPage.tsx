import { useCallback, useEffect, useState } from "react";
import { ArrowLeftRight, Building2, Clock3, RefreshCw, ShieldCheck, Wallet } from "lucide-react";

type WalletAccount = { currency: string; status: string; createdAt: string };
type TransferRecord = { id: string; type: string; status: string; createdAt: string; destinationAccountMasked: string };
type Preview = { destination: string; amount: string; currency: string };

function isWalletAccount(value: unknown): value is WalletAccount {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.currency === "string" && /^[A-Z]{3}$/.test(item.currency)
    && typeof item.status === "string" && item.status.length <= 40
    && typeof item.createdAt === "string" && Number.isFinite(Date.parse(item.createdAt));
}

function isTransferRecord(value: unknown): value is TransferRecord {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string" && item.id.length > 0 && item.id.length <= 160
    && typeof item.type === "string" && item.type.length <= 80
    && typeof item.status === "string" && item.status.length <= 40
    && typeof item.createdAt === "string" && Number.isFinite(Date.parse(item.createdAt))
    && typeof item.destinationAccountMasked === "string" && item.destinationAccountMasked.length <= 80;
}

export default function TransfersPage({ token }: { token: string }) {
  const [wallets, setWallets] = useState<WalletAccount[]>([]);
  const [history, setHistory] = useState<TransferRecord[]>([]);
  const [destination, setDestination] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("NGN");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!token || token.split(".").length !== 3) {
      setError("Your secure session is not ready. Sign in again and retry."); setLoading(false); return;
    }
    const apiBase = String(import.meta.env.VITE_API_BASE_URL || "").replace(/\/+$/, "");
    if (!apiBase) { setError("FlowPay API address is not configured."); setLoading(false); return; }
    setLoading(true); setError("");
    try {
      const headers = { Authorization: "Bearer " + token };
      const [accountResponse, historyResponse] = await Promise.all([
        fetch(apiBase + "/customer/account-details", { method: "GET", credentials: "omit", headers }),
        fetch(apiBase + "/customer/money-sent", { method: "GET", credentials: "omit", headers })
      ]);
      const [accountBody, historyBody] = await Promise.all([
        accountResponse.json().catch(() => ({})), historyResponse.json().catch(() => ({}))
      ]);
      if (!accountResponse.ok) throw new Error(typeof accountBody.error === "string" ? accountBody.error : "Unable to load your wallet accounts.");
      if (!historyResponse.ok) throw new Error(typeof historyBody.error === "string" ? historyBody.error : "Unable to load transfer history.");
      const accountList = Array.isArray(accountBody.walletAccounts) ? accountBody.walletAccounts.filter(isWalletAccount) : [];
      const transferList = Array.isArray(historyBody.transfers) ? historyBody.transfers.filter(isTransferRecord) : [];
      setWallets(accountList);
      setHistory(transferList);
      if (accountList.some(a => a.currency === "NGN")) setCurrency("NGN");
      else if (accountList[0]?.currency) setCurrency(accountList[0].currency);
      else setCurrency("NGN");
      if ((Array.isArray(accountBody.walletAccounts) && accountList.length !== accountBody.walletAccounts.length)
        || (Array.isArray(historyBody.transfers) && transferList.length !== historyBody.transfers.length)) {
        setError("Some transfer records could not be displayed because their data was incomplete.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load transfer information.");
    } finally { setLoading(false); }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  const makePreview = () => {
    setPreview(null);
    const cleanDestination = destination.replace(/\s+/g, "");
    const cleanAmount = amount.trim();
    const numericAmount = Number(cleanAmount);
    if (!/^\d{10}$/.test(cleanDestination)) { setError("Enter a 10-digit destination account number to preview. This does not verify the bank account."); return; }
    if (!/^\d+(?:\.\d{1,2})?$/.test(cleanAmount) || !Number.isFinite(numericAmount) || numericAmount <= 0) {
      setError("Enter a valid amount greater than zero, using up to two decimal places."); return;
    }
    if (!wallets.some(w => w.currency === currency && w.status.toLowerCase() === "active")) {
      setError("An active source wallet in the selected currency is required."); return;
    }
    setError("");
    setPreview({ destination: cleanDestination, amount: numericAmount.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 }), currency });
  };

  return <section className="fp-panel fp-detail-panel">
    <div className="fp-overview-card-heading"><span className="fp-overview-icon"><ArrowLeftRight size={19}/></span><span>Transfers</span></div>
    <p className="fp-muted">Prepare a transfer preview and review previous simulated transfers. No funds can be moved from this page.</p>
    {loading ? <p className="fp-overview-muted" role="status">Loading your wallet and transfer records…</p> : error && !wallets.length && !history.length ? <div className="fp-preview-warning" role="alert">{error}</div> : <>
      <div className="fp-detail-list">
        <div><span>Transfer execution</span><b>Disabled</b></div>
        <div><span>Provider verification</span><b>Not connected</b></div>
        <div><span>Live transfers</span><b>Off</b></div>
      </div>
      <h3 className="fp-account-section-title"><Wallet size={17}/> Prepare a transfer preview</h3>
      <label htmlFor="fp-transfer-currency">Source wallet currency</label>
      <select id="fp-transfer-currency" value={currency} onChange={e => { setCurrency(e.target.value); setPreview(null); setError(""); }}>
        {Array.from(new Set(wallets.map(w => w.currency))).map(code => <option key={code} value={code}>{code}</option>)}
        {!wallets.length && <option value="NGN">NGN</option>}
      </select>
      <label htmlFor="fp-transfer-destination">Destination account number</label>
      <input id="fp-transfer-destination" value={destination} onChange={e => { setDestination(e.target.value.replace(/\D/g, "").slice(0, 10)); setPreview(null); setError(""); }} inputMode="numeric" placeholder="10-digit account number" maxLength={10}/>
      <label htmlFor="fp-transfer-amount">Amount</label>
      <input id="fp-transfer-amount" value={amount} onChange={e => { const raw = e.target.value.replace(/[^0-9.]/g, ""); const [whole, ...decimals] = raw.split("."); setAmount((decimals.length ? whole + "." + decimals.join("").slice(0, 2) : whole).slice(0, 15)); setPreview(null); setError(""); }} inputMode="decimal" placeholder="0.00" maxLength={15}/>
      {error && <div className="fp-preview-warning" role="alert">{error}</div>}
      <button className="fp-outline" type="button" onClick={makePreview} disabled={loading || !wallets.some(w => w.currency === currency && w.status.toLowerCase() === "active")}>Preview only</button>
      {preview && <div className="fp-preview-warning" role="status">
        <b>Local preview only — not submitted</b>
        <div>Destination: ••••{preview.destination.slice(-4)}</div>
        <div>Amount: {preview.currency} {preview.amount}</div>
        <div>No bank lookup, beneficiary validation, wallet debit or transfer request was made.</div>
      </div>}
      <div className="fp-preview-warning"><ShieldCheck size={17}/> Transfers remain disabled until beneficiary verification, available-balance calculation, transaction authorization, ledger posting and reconciliation are implemented and tested. Never share your PIN or passkey.</div>
    </>}
    <div className="fp-overview-card-heading"><span className="fp-overview-icon"><Clock3 size={19}/></span><span>Recent transfer records</span></div>
    {loading ? <p className="fp-overview-muted">Loading records…</p> : history.length ? <div className="fp-detail-list">
      {history.map(item => <div key={item.id}><span>{item.type} · {item.destinationAccountMasked}<small>{new Date(item.createdAt).toLocaleString()}</small></span><b>{item.status}</b></div>)}
    </div> : <div className="fp-empty"><Building2 size={22}/><b>No simulated transfers recorded</b><span>When a test transfer is recorded, its status will appear here.</span></div>}
    <button className="fp-outline" type="button" onClick={() => void load()} disabled={loading}><RefreshCw size={16}/> Refresh transfer records</button>
  </section>;
}
