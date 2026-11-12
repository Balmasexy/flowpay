import { useCallback, useEffect, useState } from "react";
import { Building2, Check, Clock3, Copy, FileText, RefreshCw, ShieldCheck, Wallet } from "lucide-react";

type WalletAccount = { currency: string; status: string; createdAt: string };
type AccountDetails = {
  flowpayAccountNumber: string | null;
  walletAccounts: WalletAccount[];
  virtualBankAccount: {
    assigned: boolean; status: string; environment: "test" | "live";
    accountNumber: string | null; bankName: string | null; accountName: string | null;
  };
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
    flowpayAccountNumber: optionalText(body.flowpayAccountNumber, 10),
    walletAccounts,
    virtualBankAccount: {
      assigned: virtual.assigned,
      status: typeof virtual.status === "string" ? virtual.status.slice(0, 30) : virtual.assigned ? "assigned" : "not_requested",
      environment: virtual.environment === "live" ? "live" : "test",
      accountNumber, bankName, accountName
    },
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
  const [virtualConsent, setVirtualConsent] = useState(false);
  const [virtualBvn, setVirtualBvn] = useState("");
  const [linkedBankAccount, setLinkedBankAccount] = useState("");
  const [linkedBankCode, setLinkedBankCode] = useState("");
  const [banks, setBanks] = useState<{ code: string; name: string }[]>([]);
  const [banksError, setBanksError] = useState("");
  const [virtualRequestBusy, setVirtualRequestBusy] = useState(false);
  const [virtualRequestError, setVirtualRequestError] = useState("");
  const [virtualRequestMessage, setVirtualRequestMessage] = useState("");

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
      if (parsed.virtualBankAccount.environment === "live" && !parsed.virtualBankAccount.assigned) {
        const bankResponse = await fetch(apiBase + "/customer/banks", {
          method: "GET", credentials: "omit", headers: { Authorization: "Bearer " + token }
        });
        const bankBody = asRecord(await bankResponse.json().catch(() => null));
        const bankItems = Array.isArray(bankBody?.banks) ? bankBody.banks.map(item => asRecord(item)).filter((item): item is Record<string, unknown> => Boolean(item && typeof item.code === "string" && typeof item.name === "string"))
          .map(item => ({ code: String(item.code), name: String(item.name) })) : [];
        setBanks(bankItems);
        setBanksError(bankResponse.ok ? "" : "Live Paystack bank directory is unavailable. Refresh to try again.");
        if (bankItems.length && !linkedBankCode) setLinkedBankCode(bankItems[0].code);
      } else {
        setBanks([]);
        setBanksError("");
      }
      setData(parsed);
    } catch (cause) {
      setData(null); setError(cause instanceof Error ? cause.message : "Unable to load account details.");
    } finally { setLoading(false); }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  const requestVirtualBankAccount = async () => {
    if (!data || !virtualConsent || virtualRequestBusy) return;
    const live = data.virtualBankAccount.environment === "live";
    if (live && (!/^\\d{11}$/.test(virtualBvn) || !/^\\d{10}$/.test(linkedBankAccount) || !linkedBankCode)) {
      setVirtualRequestError("Enter your 11-digit BVN and the 10-digit bank account linked to it.");
      return;
    }
    const apiBase = String(import.meta.env.VITE_API_BASE_URL || "").replace(/\/+$/, "");
    if (!apiBase) { setVirtualRequestError("FlowPay API address is not configured."); return; }
    setVirtualRequestBusy(true); setVirtualRequestError(""); setVirtualRequestMessage("");
    try {
      const response = await fetch(apiBase + "/customer/dedicated-bank-account", {
        method: "POST", credentials: "omit",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({
          consent: true,
          ...(live ? { bvn: virtualBvn, accountNumber: linkedBankAccount, bankCode: linkedBankCode } : {})
        })
      });
      const body = asRecord(await response.json().catch(() => null));
      if (!response.ok) {
        throw new Error(typeof body?.message === "string" ? body.message : typeof body?.error === "string" ? body.error : "Paystack did not accept the virtual-account request.");
      }
      const raw = asRecord(body?.virtualBankAccount);
      const assigned = raw?.assigned === true && typeof raw.accountNumber === "string" && typeof raw.bankName === "string" && typeof raw.accountName === "string";
      setVirtualRequestMessage(typeof body?.message === "string" ? body.message : assigned ? "Paystack confirmed your bank account." : "Your request is pending provider confirmation. No placeholder account number has been created.");
      await load();
    } catch (cause) {
      setVirtualRequestError(cause instanceof Error ? cause.message : "Virtual bank account request failed.");
    } finally {
      setVirtualBvn("");
      setVirtualRequestBusy(false);
    }
  };

  return <section className="fp-panel fp-detail-panel fp-account-page">
    <div className="fp-account-hero">
      <span className="fp-account-hero-icon"><Building2 size={22}/></span><span className="fp-money-eyebrow">FLOWPAY · ACCOUNT CENTRE</span>
      <h2>Your account numbers</h2>
      <p>Your FlowPay number is a unique destination for transfers between FlowPay customers. A bank-issued virtual account is different and appears only when a provider confirms issuance.</p>
      <div className="fp-account-number-highlight"><div><small>YOUR FLOWPAY TRANSFER NUMBER</small><strong>{data?.flowpayAccountNumber || (loading ? "Assigning…" : "Not assigned")}</strong></div>{data?.flowpayAccountNumber && <button type="button" onClick={() => void copyValue("FlowPay account number", data.flowpayAccountNumber)} aria-label="Copy FlowPay account number"><Copy size={17}/> Copy</button>}</div>
    </div>
    {loading ? <p className="fp-overview-muted" role="status">Loading your assigned account records…</p> : error ? <div className="fp-preview-warning" role="alert">{error}</div> : <>
      <div className="fp-account-detail-grid">
        <article className="fp-account-type-card fp-account-wallet-card"><span className="fp-account-type-icon"><Wallet size={19}/></span><span className="fp-money-eyebrow">FLOWPAY WALLET</span><h3>To FlowPay</h3><p>Use this unique 10-digit FlowPay number when another FlowPay customer sends you money.</p><div className="fp-account-type-value">{data?.flowpayAccountNumber || "Not yet assigned"}</div><span className="fp-account-live-label"><Check size={14}/> {data?.flowpayAccountNumber ? "Assigned to your customer profile" : "Awaiting assignment"}</span>{data?.flowpayAccountNumber && <button type="button" className="fp-outline" onClick={() => void copyValue("FlowPay account number", data.flowpayAccountNumber)}><Copy size={14}/> Copy number</button>}</article>
        <article className="fp-account-type-card fp-account-bank-card"><span className="fp-account-type-icon"><Building2 size={19}/></span><span className="fp-money-eyebrow">BANK TRANSFER ACCOUNT</span><h3>Receive from any bank</h3>
          {data?.virtualBankAccount.assigned ? <><p>Provider-confirmed {data.virtualBankAccount.environment} bank account linked to your FlowPay customer profile.</p><div className="fp-account-type-value">{data.virtualBankAccount.accountNumber}</div><div className="fp-account-bank-details"><span>Bank</span><b>{data.virtualBankAccount.bankName}</b><span>Account name</span><b>{data.virtualBankAccount.accountName}</b></div><span className="fp-account-live-label"><Check size={14}/> Provider assignment confirmed</span></> : <><p>A dedicated bank NUBAN has not yet been issued. The FlowPay transfer number above cannot receive transfers from outside banks.</p><div className="fp-account-pending"><Clock3 size={18}/><span><b>{data?.virtualBankAccount.status === "pending" ? "Request awaiting Paystack" : "Bank account not issued"}</b><small>{data?.virtualBankAccount.status === "pending" ? "Your account request is already being processed. FlowPay will display the number only after Paystack confirms assignment." : "Paystack must approve FlowPay's DVA access. This request is sent only after your explicit consent."}</small></span></div><span className="fp-account-live-label is-pending"><ShieldCheck size={14}/> No placeholder bank number displayed</span>
            {data?.virtualBankAccount.status !== "pending" && <>
              <label style={{display:"flex",alignItems:"flex-start",gap:8,marginTop:12,fontSize:13}}>
                <input type="checkbox" checked={virtualConsent} onChange={event=>setVirtualConsent(event.target.checked)} disabled={virtualRequestBusy}/>
                I expressly consent to FlowPay sending the profile information required by Paystack to request a dedicated bank account. For a live financial-services account, Paystack will also receive my BVN and the bank account details linked to it for validation.
              </label>
              {data?.virtualBankAccount.environment === "live" && <>
                <label htmlFor="customer-dva-bvn">BVN (11 digits)</label>
                <input id="customer-dva-bvn" type="password" inputMode="numeric" autoComplete="off" maxLength={11} value={virtualBvn} onChange={event=>setVirtualBvn(event.target.value.replace(/\\D/g,"").slice(0,11))} placeholder="Enter BVN for Paystack validation" disabled={virtualRequestBusy}/>
                <label htmlFor="customer-dva-bank">BVN-linked bank</label>
                <select id="customer-dva-bank" value={linkedBankCode} onChange={event=>setLinkedBankCode(event.target.value)} disabled={virtualRequestBusy || !banks.length}>
                  {banks.map(bank=><option key={bank.code} value={bank.code}>{bank.name}</option>)}
                </select>
                <label htmlFor="customer-dva-account">BVN-linked account number</label>
                <input id="customer-dva-account" inputMode="numeric" autoComplete="off" maxLength={10} value={linkedBankAccount} onChange={event=>setLinkedBankAccount(event.target.value.replace(/\\D/g,"").slice(0,10))} placeholder="10-digit bank account number" disabled={virtualRequestBusy}/>
                {banksError && <p className="fp-preview-warning" role="alert">{banksError}</p>}
                <small>The BVN is sent to Paystack for validation and is not saved in FlowPay.</small>
              </>}
              {virtualRequestError && <p className="fp-preview-warning" role="alert">{virtualRequestError}</p>}
              {virtualRequestMessage && <p className="fp-muted" role="status">{virtualRequestMessage}</p>}
              <button type="button" className="fp-primary" style={{marginTop:12}} onClick={()=>void requestVirtualBankAccount()} disabled={!virtualConsent || virtualRequestBusy || (data?.virtualBankAccount.environment === "live" && (virtualBvn.length !== 11 || linkedBankAccount.length !== 10 || !linkedBankCode))}>
                {virtualRequestBusy ? "Requesting bank account…" : "Request dedicated bank account"}
              </button>
            </>}
          </>}
        </article>
      </div>
      <div className="fp-account-wallets"><div className="fp-money-section-heading"><div><span className="fp-money-eyebrow">LEDGER ACCOUNTS</span><h3>Your FlowPay wallets</h3></div><span className="fp-money-count">{data?.walletAccounts.length ?? 0} currencies</span></div>
        {data?.walletAccounts.length ? <div className="fp-account-wallet-list">{data.walletAccounts.map((wallet,index)=><div key={wallet.currency+"-"+index}><span className="fp-account-currency">{wallet.currency.slice(0,2)}</span><span><b>{wallet.currency} wallet</b><small>Created {dateLabel(wallet.createdAt)}</small></span><strong>{wallet.status === "active" ? "Active" : wallet.status}</strong></div>)}</div> : <div className="fp-empty"><Wallet size={22}/><b>No wallet account is linked</b><span>Contact FlowPay support if you believe this is incorrect.</span></div>}
      </div>
      {copied && <p className="fp-muted" role="status"><Check size={14}/> {copied === "Clipboard unavailable" ? copied : copied + " copied"}</p>}
      <div className="fp-preview-warning"><ShieldCheck size={17}/>{data?.message}</div>
    </>}
    <div className="fp-account-actions"><button className="fp-outline" type="button" onClick={() => void load()} disabled={loading}><RefreshCw size={16}/> Refresh account details</button>{go && <button className="fp-outline" type="button" onClick={() => go("/documents")}><FileText size={16}/> Documents</button>}</div>
  </section>;
}
