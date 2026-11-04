import { useCallback, useEffect, useState } from "react";
import { Building2, Check, Copy, FileText, RefreshCw, ShieldCheck, Wallet } from "lucide-react";

type WalletAccount = { currency: string; status: string; createdAt: string };
type AccountDetails = {
  walletAccounts: WalletAccount[];
  virtualBankAccount: { assigned: boolean; accountNumber: string | null; bankName: string | null; accountName: string | null };
  message: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseAccountDetails(value: unknown): AccountDetails | null {
  const body = asRecord(value);
  const virtual = asRecord(body?.virtualBankAccount);
  if (!body || !virtual || !Array.isArray(body.walletAccounts) || typeof virtual.assigned !== "boolean") return null;
  const optionalText = (item: unknown, max: number): string | null => typeof item === "string" && item.trim() ? item.trim().slice(0, max) : null;
  const walletAccounts: WalletAccount[] = [];
  for (const raw of body.walletAccounts) {
    const row = asRecord(raw);
    if (!row || typeof row.currency !== "string" || !/^[A-Z]{3}$/.test(row.currency) || typeof row.status !== "string" || typeof row.createdAt !== "string") return null;
    walletAccounts.push({ currency: row.currency, status: row.status.slice(0, 30), createdAt: row.createdAt });
  }
  const accountNumber = optionalText(virtual.accountNumber, 40);
  const bankName = optionalText(virtual.bankName, 100);
  const accountName = optionalText(virtual.accountName, 120);
  if (virtual.assigned && (!accountNumber || !bankName || !accountName)) return null;
  return {
    walletAccounts,
    virtualBankAccount: { assigned: virtual.assigned, accountNumber, bankName, accountName },
    message: typeof body.message === "string" ? body.message.slice(0, 300) : "Account information is read-only.",
  };
}

function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleDateString();
}

export default function CustomerAccountDetails({ token, go }: { token: string; go?: (path: string) => void }) {
  const [copied, setCopied] = useState("");
  const copyValue = async (label: string, value: string | null) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
    } catch {
      setCopied("Clipboard unavailable");
    }
  };
  const [data, setData] = useState<AccountDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!token || token.split(".").length !== 3) {
      setData(null); setError("Your secure session is not ready. Sign in again and retry."); setLoading(false); return;
    }
    const apiBase = String(import.meta.env.VITE_API_BASE_URL || "").replace(/\/+$/, "");
    if (!apiBase) { setData(null); setError("FlowPay API address is not configured."); setLoading(false); return; }
    setLoading(true); setError("");
    try {
      const response = await fetch(apiBase + "/customer/account-details", {
        method: "GET", credentials: "omit", headers: { Authorization: "Bearer " + token }
      });
      const body: unknown = await response.json().catch(() => null);
      const errorBody = asRecord(body);
      if (!response.ok) throw new Error(response.status === 401 ? "Your session has expired. Please sign in again." : typeof errorBody?.error === "string" ? errorBody.error.slice(0, 200) : "Unable to load account details.");
      const parsed = parseAccountDetails(body);
      if (!parsed) throw new Error("The account service returned incomplete or invalid account details.");
      setData(parsed);
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
        <div><span>Virtual bank account number</span><span style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}><b>{data?.virtualBankAccount.assigned ? data.virtualBankAccount.accountNumber : "Not yet assigned"}</b>{data?.virtualBankAccount.assigned && data.virtualBankAccount.accountNumber && <button type="button" className="fp-outline" onClick={() => void copyValue("Account number", data.virtualBankAccount.accountNumber)}><Copy size={14}/> Copy</button>}</span></div>
        <div><span>Bank / provider</span><span style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}><b>{data?.virtualBankAccount.bankName || "Not yet assigned"}</b>{data?.virtualBankAccount.bankName && <button type="button" className="fp-outline" onClick={() => void copyValue("Bank name", data.virtualBankAccount.bankName)}><Copy size={14}/> Copy</button>}</span></div>
        <div><span>Account name</span><span style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}><b>{data?.virtualBankAccount.accountName || "Not yet linked"}</b>{data?.virtualBankAccount.accountName && <button type="button" className="fp-outline" onClick={() => void copyValue("Account name", data.virtualBankAccount.accountName)}><Copy size={14}/> Copy</button>}</span></div>
      </div>
      {copied && <p className="fp-muted" role="status"><Check size={14}/> {copied === "Clipboard unavailable" ? copied : copied + " copied"}</p>}
      <h3 className="fp-account-section-title"><Wallet size={17}/> FlowPay wallet accounts</h3>
      {data?.walletAccounts.length ? <div className="fp-detail-list">
        {data.walletAccounts.map((account, index) => <div key={account.currency + "-" + index}>
          <span>{account.currency} wallet · {dateLabel(account.createdAt)}</span>
          <b>{account.status === "active" ? "Active" : account.status}</b>
        </div>)}
      </div> : <div className="fp-empty"><Wallet size={22}/><b>No wallet account is linked</b><span>Contact FlowPay support if you believe this is incorrect.</span></div>}
      <div className="fp-preview-warning"><ShieldCheck size={17}/>{data?.message}</div>
    </>}
    <div style={{display:"flex",gap:10,flexWrap:"wrap"}}><button className="fp-outline" type="button" onClick={() => void load()} disabled={loading}><RefreshCw size={16}/> Refresh account details</button>{go && <button className="fp-outline" type="button" onClick={() => go("/documents")}><FileText size={16}/> Documents</button>}</div>
  </section>;
}
