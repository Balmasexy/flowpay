import { useCallback, useEffect, useState } from "react";
import { Building2, RefreshCw, ShieldCheck, Wallet } from "lucide-react";

type WalletAccount = { currency: string; status: string; createdAt: string };
type AccountDetails = {
  walletAccounts: WalletAccount[];
  virtualBankAccount: { assigned: boolean; accountNumber: string | null; bankName: string | null; accountName: string | null };
  message: string;
};

export default function CustomerAccountDetails({ token }: { token: string }) {
  const [data, setData] = useState<AccountDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!token || token.split(".").length !== 3) {
      setData(null); setError("Your secure session is not ready. Sign in again and retry."); setLoading(false); return;
    }
    const apiBase = String(import.meta.env.VITE_API_BASE_URL || "").replace(/\\/+$/, "");
    if (!apiBase) { setData(null); setError("FlowPay API address is not configured."); setLoading(false); return; }
    setLoading(true); setError("");
    try {
      const response = await fetch(apiBase + "/customer/account-details", {
        method: "GET", credentials: "omit", headers: { Authorization: "Bearer " + token }
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(response.status === 401 ? "Your session has expired. Please sign in again." : body.error || "Unable to load account details.");
      setData(body as AccountDetails);
    } catch (cause) {
      setData(null); setError(cause instanceof Error ? cause.message : "Unable to load account details.");
    } finally { setLoading(false); }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  return <section className="fp-panel fp-detail-panel">
    <div className="fp-overview-card-heading"><span className="fp-overview-icon"><Building2 size={19}/></span><span>Account information</span></div>
    <p className="fp-muted">Your FlowPay wallet ledger account and any verified virtual bank account assignment.</p>
    {loading ? <p className="fp-overview-muted" role="status">Loading your account records…</p> : error ? <div className="fp-preview-warning" role="alert">{error}</div> : <>
      <div className="fp-detail-list">
        <div><span>Virtual bank account number</span><b>{data?.virtualBankAccount.assigned ? data.virtualBankAccount.accountNumber : "Not yet assigned"}</b></div>
        <div><span>Bank / provider</span><b>{data?.virtualBankAccount.bankName || "Not yet assigned"}</b></div>
        <div><span>Account name</span><b>{data?.virtualBankAccount.accountName || "Not yet linked"}</b></div>
      </div>
      <h3 className="fp-account-section-title"><Wallet size={17}/> FlowPay wallet accounts</h3>
      {data?.walletAccounts.length ? <div className="fp-detail-list">
        {data.walletAccounts.map((account, index) => <div key={account.currency + "-" + index}>
          <span>{account.currency} wallet · {new Date(account.createdAt).toLocaleDateString()}</span>
          <b>{account.status === "active" ? "Active" : account.status}</b>
        </div>)}
      </div> : <div className="fp-empty"><Wallet size={22}/><b>No wallet account is linked</b><span>Contact FlowPay support if you believe this is incorrect.</span></div>}
      <div className="fp-preview-warning"><ShieldCheck size={17}/>{data?.message}</div>
    </>}
    <button className="fp-outline" type="button" onClick={() => void load()} disabled={loading}><RefreshCw size={16}/> Refresh account details</button>
  </section>;
}
