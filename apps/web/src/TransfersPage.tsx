import { useCallback, useEffect, useState } from "react";
import { ArrowLeftRight, Building2, Clock3, RefreshCw, ShieldCheck, Wallet } from "lucide-react";

type WalletAccount = { currency: string; status: string; createdAt: string };
type TransferRecord = { id: string; type: string; status: string; createdAt: string; destinationAccountMasked: string };
type Preview = { destination: string; amount: string; currency: string };

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
      if (!accountResponse.ok) throw new Error(accountBody.error || "Unable to load your wallet accounts.");
      if (!historyResponse.ok) throw new Error(historyBody.error || "Unable to load transfer history.");
      const accountList = Array.isArray(accountBody.walletAccounts) ? accountBody.walletAccounts : [];
      setWallets(accountList);
      setHistory(Array.isArray(historyBody.transfers) ? historyBody.transfers : []);
      if (accountList.some((a: WalletAccount) => a.currency === "NGN")) setCurrency("NGN");
      else if (accountList[0]?.currency) setCurrency(accountList[0].currency);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load transfer information.");
    } finally { setLoading(false); }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  const makePreview = () => {
    setPreview(null);
    const cleanDestination = destination.replace(/\s+/g, "");
    const numericAmount = Number(amount);
    if (!/^\d{10}$/.test(cleanDestination)) { setError("Enter a 10-digit destination account number to preview. This does not verify the bank account."); return; }
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) { setError("Enter an amount greater than zero."); return; }
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
      <select id="fp-transfer-currency" value={currency} onChange={e => { setCurrency(e.target.value); setPreview(null); }}>
        {Array.from(new Set(wallets.map(w => w.currency))).map(code => <option key={code} value={code}>{code}</option>)}
        {!wallets.length && <option value="NGN">NGN</option>}
      </select>
      <label htmlFor="fp-transfer-destination">Destination account number</label>
      <input id="fp-transfer-destination" value={destination} onChange={e => { setDestination(e.target.value.replace(/\D/g, "").slice(0, 10)); setPreview(null); }} inputMode="numeric" placeholder="10-digit account number" maxLength={10}/>
      <label htmlFor="fp-transfer-amount">Amount</label>
      <input id="fp-transfer-amount" value={amount} onChange={e => { setAmount(e.target.value); setPreview(null); }} inputMode="decimal" placeholder="0.00"/>
      {error && <div className="fp-preview-warning" role="alert">{error}</div>}
      <button className="fp-outline" type="button" onClick={makePreview} disabled={loading || !wallets.some(w => w.currency === currency && w.status === "active")}>Preview only</button>
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
