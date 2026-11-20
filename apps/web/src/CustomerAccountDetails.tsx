import { useCallback, useEffect, useState } from "react";
import { Building2, Check, Copy, FileText, RefreshCw, ShieldCheck, Smartphone, Wallet } from "lucide-react";

type WalletAccount = { currency: string; status: string; createdAt: string };
type AccountDetails = {
  flowpayAccountNumber: string | null;
  walletAccounts: WalletAccount[];
  message: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function parseAccountDetails(value: unknown): AccountDetails | null {
  const body = asRecord(value);
  if (!body || !Array.isArray(body.walletAccounts)) return null;
  const wallets: WalletAccount[] = [];
  for (const raw of body.walletAccounts) {
    const row = asRecord(raw);
    if (!row || typeof row.currency !== "string" || !/^[A-Z]{3}$/.test(row.currency) ||
        typeof row.status !== "string" || typeof row.createdAt !== "string" ||
        !Number.isFinite(Date.parse(row.createdAt))) return null;
    wallets.push({
      currency: row.currency,
      status: row.status.slice(0, 30),
      createdAt: row.createdAt
    });
  }
  const flowpayAccountNumber = typeof body.flowpayAccountNumber === "string" &&
    /^[1-9][0-9]{9}$/.test(body.flowpayAccountNumber) ? body.flowpayAccountNumber : null;
  return {
    flowpayAccountNumber,
    walletAccounts: wallets,
    message: typeof body.message === "string" ? body.message.slice(0, 300) : "Account information is read-only."
  };
}

function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleDateString();
}

export default function CustomerAccountDetails({ token, go }: { token: string; go?: (path: string) => void }) {
  const [copied, setCopied] = useState("");
  const [data, setData] = useState<AccountDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const copyFlowPayId = async () => {
    if (!data?.flowpayAccountNumber) return;
    try {
      await navigator.clipboard.writeText(data.flowpayAccountNumber);
      setCopied("FlowPay ID copied");
    } catch {
      setCopied("Clipboard unavailable");
    }
  };

  const load = useCallback(async () => {
    if (!token || token.split(".").length !== 3) {
      setData(null);
      setError("Your secure session is not ready. Sign in again and retry.");
      setLoading(false);
      return;
    }
    const apiBase = String(import.meta.env.VITE_API_BASE_URL || "").replace(/\/+$/, "");
    if (!apiBase) {
      setData(null);
      setError("FlowPay API address is not configured.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await fetch(apiBase + "/customer/account-details", {
        method: "GET",
        credentials: "omit",
        headers: { Authorization: "Bearer " + token }
      });
      const body: unknown = await response.json().catch(() => null);
      const errorBody = asRecord(body);
      if (!response.ok) {
        throw new Error(response.status === 401
          ? "Your session has expired. Please sign in again."
          : typeof errorBody?.error === "string" ? errorBody.error.slice(0, 200) : "Unable to load account details.");
      }
      const parsed = parseAccountDetails(body);
      if (!parsed) throw new Error("The account service returned incomplete or invalid account details.");
      setData(parsed);
    } catch (cause) {
      setData(null);
      setError(cause instanceof Error ? cause.message : "Unable to load account details.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  return <section className="fp-panel fp-detail-panel fp-account-page">
    <div className="fp-account-hero">
      <span className="fp-account-hero-icon"><Building2 size={22}/></span>
      <span className="fp-money-eyebrow">FLOWPAY · ACCOUNT CENTRE</span>
      <h2>Your FlowPay identity</h2>
      <p>Your permanent 10-digit FlowPay ID and your Neon-verified mobile number identify the same FlowPay wallet. No customer NUBAN is created or displayed here.</p>
      <div className="fp-account-number-highlight">
        <div>
          <small>YOUR PERMANENT FLOWPAY ID</small>
          <strong>{data?.flowpayAccountNumber || (loading ? "Assigning…" : "Not assigned")}</strong>
        </div>
        {data?.flowpayAccountNumber && <button type="button" onClick={() => void copyFlowPayId()} aria-label="Copy FlowPay ID">
          <Copy size={17}/> Copy
        </button>}
      </div>
    </div>

    {loading ? <p className="fp-overview-muted" role="status">Loading your FlowPay identity and wallets…</p>
      : error ? <div className="fp-preview-warning" role="alert">{error}</div>
      : <>
        <div className="fp-account-detail-grid">
          <article className="fp-account-type-card fp-account-wallet-card">
            <span className="fp-account-type-icon"><Wallet size={19}/></span>
            <span className="fp-money-eyebrow">FLOWPAY WALLET</span>
            <h3>Receive from FlowPay</h3>
            <p>Share this permanent 10-digit ID with another FlowPay customer to receive a wallet transfer.</p>
            <div className="fp-account-type-value">{data?.flowpayAccountNumber || "Not yet assigned"}</div>
            <span className="fp-account-live-label">
              <Check size={14}/> {data?.flowpayAccountNumber ? "Permanent ID assigned" : "Awaiting assignment"}
            </span>
            {data?.flowpayAccountNumber && <button type="button" className="fp-outline" onClick={() => void copyFlowPayId()}>
              <Copy size={14}/> Copy FlowPay ID
            </button>}
          </article>
          <article className="fp-account-type-card fp-account-bank-card">
            <span className="fp-account-type-icon"><Smartphone size={19}/></span>
            <span className="fp-money-eyebrow">PHONE-BASED RECEIVING</span>
            <h3>Receive by mobile number</h3>
            <p>Your Neon-verified Nigerian mobile number is a second way for another FlowPay customer to find this same wallet.</p>
            <span className="fp-account-live-label is-pending"><ShieldCheck size={14}/> Neon Auth verification</span>
            <small className="fp-muted">Phone-number transfers from other Nigerian banks require FlowPay's NIBSS National Payment Stack participant integration and certification. That external-bank route is not active until approval is confirmed. FlowPay does not display or generate a customer NUBAN.</small>
          </article>
        </div>

        <div className="fp-account-wallets">
          <div className="fp-money-section-heading">
            <div><span className="fp-money-eyebrow">LEDGER ACCOUNTS</span><h3>Your FlowPay wallets</h3></div>
            <span className="fp-money-count">{data?.walletAccounts.length ?? 0} currencies</span>
          </div>
          {data?.walletAccounts.length
            ? <div className="fp-account-wallet-list">
                {data.walletAccounts.map((wallet,index)=><div key={wallet.currency+"-"+index}>
                  <span className="fp-account-currency">{wallet.currency.slice(0,2)}</span>
                  <span><b>{wallet.currency} wallet</b><small>Created {dateLabel(wallet.createdAt)}</small></span>
                  <strong>{wallet.status === "active" ? "Active" : wallet.status}</strong>
                </div>)}
              </div>
            : <div className="fp-empty"><Wallet size={22}/><b>No wallet account is linked</b><span>Contact FlowPay support if you believe this is incorrect.</span></div>}
        </div>
        {copied && <p className="fp-muted" role="status"><Check size={14}/> {copied}</p>}
        <div className="fp-preview-warning"><ShieldCheck size={17}/>{data?.message}</div>
      </>}

    <div className="fp-account-actions">
      <button className="fp-outline" type="button" onClick={() => void load()} disabled={loading}>
        <RefreshCw size={16}/> Refresh account details
      </button>
      {go && <button className="fp-outline" type="button" onClick={() => go("/documents")}><FileText size={16}/> Documents</button>}
    </div>
  </section>;
}
