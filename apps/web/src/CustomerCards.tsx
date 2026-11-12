import { useEffect, useState } from "react";
import { getApiJwt } from "./auth-client";
import {
  AlertCircle, Building2, Check, Copy, CreditCard, RefreshCw, ShieldCheck
} from "lucide-react";

type Card = {
  id: string;
  provider: string;
  type: "virtual" | "physical";
  status: "pending" | "active" | "frozen" | "blocked" | "closed" | "failed";
  last4: string | null;
  expiryMonth: number | null;
  expiryYear: number | null;
  createdAt: string;
};
type VirtualBankAccount = {
  assigned: boolean;
  status: string;
  environment: "test" | "live";
  accountNumber: string | null;
  bankName: string | null;
  accountName: string | null;
};

const CARD_STATUSES = new Set<Card["status"]>([
  "pending", "active", "frozen", "blocked", "closed", "failed"
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function parseCards(value: unknown): Card[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): Card[] => {
    const raw = asRecord(item);
    if (typeof raw.id !== "string" || !raw.id.trim()) return [];
    const month = typeof raw.expiryMonth === "number" && Number.isInteger(raw.expiryMonth) &&
      raw.expiryMonth >= 1 && raw.expiryMonth <= 12 ? raw.expiryMonth : null;
    const year = typeof raw.expiryYear === "number" && Number.isInteger(raw.expiryYear) &&
      raw.expiryYear >= 2000 && raw.expiryYear <= 2200 ? raw.expiryYear : null;
    return [{
      id: raw.id,
      provider: typeof raw.provider === "string" && raw.provider.trim() ? raw.provider : "Card provider",
      type: raw.type === "physical" ? "physical" : "virtual",
      status: typeof raw.status === "string" && CARD_STATUSES.has(raw.status as Card["status"])
        ? raw.status as Card["status"] : "pending",
      last4: typeof raw.last4 === "string" && /^[0-9]{4}$/.test(raw.last4) ? raw.last4 : null,
      expiryMonth: month,
      expiryYear: year,
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : ""
    }];
  });
}

function parseVirtualBankAccount(value: unknown): VirtualBankAccount {
  const raw = asRecord(value);
  const assigned = raw.assigned === true &&
    typeof raw.accountNumber === "string" && /^[0-9]{10}$/.test(raw.accountNumber) &&
    typeof raw.bankName === "string" && !!raw.bankName.trim() &&
    typeof raw.accountName === "string" && !!raw.accountName.trim();
  return {
    assigned,
    status: typeof raw.status === "string" ? raw.status : assigned ? "assigned" : "not_requested",
    environment: raw.environment === "live" ? "live" : "test",
    accountNumber: assigned ? raw.accountNumber as string : null,
    bankName: assigned ? raw.bankName as string : null,
    accountName: assigned ? raw.accountName as string : null
  };
}

export default function CustomerCards({ token, registeredName }: { token: string; registeredName?: string | null }) {
  const [cards, setCards] = useState<Card[]>([]);
  const [cardholderName, setCardholderName] = useState<string | null>(null);
  const [virtualBankAccount, setVirtualBankAccount] = useState<VirtualBankAccount>({
    assigned: false, status: "not_requested", environment: "test", accountNumber: null, bankName: null, accountName: null
  });
  const [accountConsent, setAccountConsent] = useState(false);
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountError, setAccountError] = useState("");
  const [accountMessage, setAccountMessage] = useState("");
  const [bvn, setBvn] = useState("");
  const [linkedBankAccount, setLinkedBankAccount] = useState("");
  const [linkedBankCode, setLinkedBankCode] = useState("");
  const [banks, setBanks] = useState<{code:string;name:string}[]>([]);
  const [banksError, setBanksError] = useState("");
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const apiBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") || "";
  const dedicatedAccountApiBase = (import.meta.env.VITE_DEDICATED_ACCOUNT_API_BASE_URL as string | undefined)?.replace(/\/$/, "") || apiBase;

  useEffect(() => {
    let active = true;
    if (!token || !apiBase) {
      setCards([]);
      setCardholderName(null);
      setVirtualBankAccount({
        assigned: false, status: "not_requested", environment: "test", accountNumber: null, bankName: null, accountName: null
      });
      setError("Your authenticated cards service is not configured.");
      setLoading(false);
      return () => { active = false; };
    }
    setLoading(true);
    setError("");
    getApiJwt().then(jwt => fetch(apiBase + "/customer/cards", {
      method: "GET", credentials: "omit",
      headers: { Authorization: "Bearer " + jwt }
    })).then(async response => {
      const data: unknown = await response.json().catch(() => ({}));
      const body = asRecord(data);
      if (!response.ok) {
        throw new Error(typeof body.error === "string" ? body.error : "Unable to load cards.");
      }
      return body;
    }).then(async body => {
      if (!active) return;
      setCardholderName(typeof body.cardholderName === "string" && body.cardholderName.trim()
        ? body.cardholderName.trim().slice(0, 100) : null);
      setCards(parseCards(body.cards));
      const virtual = parseVirtualBankAccount(body.virtualBankAccount);
      setVirtualBankAccount(virtual);
      if (virtual.environment === "live" && !virtual.assigned) {
        try {
          const jwt = await getApiJwt();
          const bankResponse = await fetch(apiBase + "/customer/banks", {
            method: "GET", credentials: "omit", headers: { Authorization: "Bearer " + jwt }
          });
          const bankBody = asRecord(await bankResponse.json().catch(() => ({})));
          const items = Array.isArray(bankBody.banks) ? bankBody.banks.flatMap(item => {
            const bank = asRecord(item);
            return typeof bank.code === "string" && typeof bank.name === "string"
              ? [{code:bank.code,name:bank.name}] : [];
          }) : [];
          if (active) {
            setBanks(items);
            setBanksError(bankResponse.ok ? "" : "Paystack bank directory is unavailable. Refresh to retry.");
            if (items.length && !linkedBankCode) setLinkedBankCode(items[0].code);
          }
        } catch {
          if (active) setBanksError("Unable to load the BVN-linked bank directory. Refresh to retry.");
        }
      } else if (active) {
        setBanks([]);
        setBanksError("");
      }
    }).catch(cause => {
      if (!active) return;
      setCards([]);
      setCardholderName(null);
      setVirtualBankAccount({
        assigned: false, status: "not_requested", accountNumber: null, bankName: null, accountName: null
      });
      setError(cause instanceof Error ? cause.message : "Unable to load cards.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token, apiBase, refresh]);

  const requestVirtualBankAccount = async () => {
    if (accountBusy || !accountConsent || !apiBase) return;
    if (virtualBankAccount.environment === "live" &&
      (!/^\d{11}$/.test(bvn) || !/^\d{10}$/.test(linkedBankAccount) || !linkedBankCode)) {
      setAccountError("Enter your 11-digit BVN and the 10-digit bank account linked to it.");
      return;
    }
    setAccountBusy(true);
    setAccountError("");
    setAccountMessage("");
    try {
      const jwt = await getApiJwt();
      const response = await fetch(dedicatedAccountApiBase + "/customer/dedicated-bank-account", {
        method: "POST", credentials: "omit",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + jwt },
        body: JSON.stringify({
          consent: true,
          ...(virtualBankAccount.environment === "live"
            ? { bvn, accountNumber: linkedBankAccount, bankCode: linkedBankCode }
            : {})
        })
      });
      const body = asRecord(await response.json().catch(() => ({})));
      if (!response.ok && response.status !== 202) {
        const providerDetail = typeof body.providerMessage === "string" ? body.providerMessage.slice(0, 240) : "";
        const providerStatus = typeof body.providerStatus === "number" ? " (HTTP " + body.providerStatus + ")" : "";
        throw new Error(providerDetail
          ? "Paystack rejected the dedicated-account request" + providerStatus + ": " + providerDetail
          : typeof body.message === "string" ? body.message :
            typeof body.error === "string" ? body.error : "Unable to request a virtual bank account.");
      }
      setVirtualBankAccount(parseVirtualBankAccount(body.virtualBankAccount));
      setAccountMessage(typeof body.message === "string" ? body.message :
        body.status === "pending" ? "Paystack is processing the test account request." :
          "Paystack returned the account assignment status.");
      setAccountConsent(false);
      setBvn("");
      setLinkedBankAccount("");
      setRefresh(value => value + 1);
    } catch (cause) {
      setAccountError(cause instanceof Error ? cause.message : "Unable to request a virtual bank account.");
    } finally {
      setAccountBusy(false);
    }
  };

  const copyVirtualAccount = async () => {
    if (!virtualBankAccount.accountNumber) return;
    try {
      await navigator.clipboard.writeText(virtualBankAccount.accountNumber);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setAccountError("Clipboard unavailable. Select and copy the account number manually.");
    }
  };

  return <section className="fp-panel fp-detail-panel">
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}>
      <div>
        <h2>Cards</h2>
        <p className="fp-muted">View issuer-confirmed card records and your provider-issued bank account.</p>
      </div>
      <button type="button" className="fp-outline" onClick={() => setRefresh(value => value + 1)} disabled={loading}>
        <RefreshCw size={15}/> Refresh
      </button>
    </div>

    <div className="fp-detail-list">
      <div><span>Cardholder name</span><b>{cardholderName || registeredName?.trim() || "Not available on this profile"}</b></div>
      <div><span>Card number</span><b>Available only after issuer-confirmed issuance</b></div>
    </div>

    <div style={{marginTop:20,border:"1px solid var(--fp-border, #e5e7eb)",borderRadius:16,padding:16,display:"grid",gap:10}}>
      <div style={{display:"flex",alignItems:"center",gap:9}}>
        <Building2 size={19}/><b>Virtual bank account</b>
        <span style={{marginLeft:"auto",fontSize:11,fontWeight:800,color:virtualBankAccount.assigned ? "#15803d" : "#9a3412"}}>
          {virtualBankAccount.assigned ? "ASSIGNED" : virtualBankAccount.status.toUpperCase().replace(/_/g," ")}
        </span>
      </div>
      {virtualBankAccount.assigned ? <>
        <div className="fp-detail-list">
          <div><span>Bank</span><b>{virtualBankAccount.bankName}</b></div>
          <div><span>Account name</span><b>{virtualBankAccount.accountName}</b></div>
          <div><span>10-digit account number</span><b style={{fontSize:20,letterSpacing:1.2}}>{virtualBankAccount.accountNumber}</b></div>
        </div>
        <button type="button" className="fp-outline" onClick={() => void copyVirtualAccount()}>
          {copied ? <Check size={15}/> : <Copy size={15}/>} {copied ? "Copied" : "Copy virtual account number"}
        </button>
      </> : <>
        <p className="fp-muted" style={{margin:0}}>
          This Paystack-issued account is for receiving NGN bank transfers. It is separate from your 10-digit FlowPay wallet number and from your card number.
        </p>
        <label style={{display:"flex",alignItems:"flex-start",gap:9,fontSize:13,lineHeight:1.45}}>
          <input type="checkbox" checked={accountConsent} onChange={event => setAccountConsent(event.target.checked)} style={{marginTop:3}}/>
          <span>I consent to FlowPay sending my registered name, email address and phone number to Paystack to request a dedicated NGN virtual bank account for this profile.</span>
        </label>
        {virtualBankAccount.environment === "live" && <>
          <label htmlFor="flowpay-card-bvn">BVN (11 digits)</label>
          <input id="flowpay-card-bvn" type="password" inputMode="numeric" autoComplete="off" maxLength={11}
            value={bvn} onChange={event=>setBvn(event.target.value.replace(/\D/g,"").slice(0,11))}
            placeholder="Enter BVN for Paystack validation" disabled={accountBusy}/>
          <label htmlFor="flowpay-card-bank">BVN-linked bank</label>
          <select id="flowpay-card-bank" value={linkedBankCode} onChange={event=>setLinkedBankCode(event.target.value)} disabled={accountBusy || !banks.length}>
            {banks.map(bank=><option key={bank.code} value={bank.code}>{bank.name}</option>)}
          </select>
          <label htmlFor="flowpay-card-account">BVN-linked account number</label>
          <input id="flowpay-card-account" inputMode="numeric" autoComplete="off" maxLength={10}
            value={linkedBankAccount} onChange={event=>setLinkedBankAccount(event.target.value.replace(/\D/g,"").slice(0,10))}
            placeholder="10-digit bank account number" disabled={accountBusy}/>
          <small className="fp-muted">Your BVN is sent to Paystack for identity validation and is not saved by FlowPay.</small>
          {banksError && <div className="fp-preview-warning" role="alert">{banksError}</div>}
        </>}
        <button type="button" className="fp-primary"
          disabled={!accountConsent || accountBusy || loading || virtualBankAccount.status === "pending" || (virtualBankAccount.environment === "live" && (bvn.length !== 11 || linkedBankAccount.length !== 10 || !linkedBankCode))}
          onClick={() => void requestVirtualBankAccount()}>
          {accountBusy ? "Requesting with Paystack…" : virtualBankAccount.status === "pending" ? "Request already pending" : "Request dedicated bank account"}
        </button>
        <small className="fp-muted">
          {virtualBankAccount.environment === "live"
            ? "Live requests require Paystack live DVA access and successful customer eligibility checks. The account appears only after provider confirmation."
            : "Sandbox request. Paystack must accept and confirm the assignment before a number is shown. No placeholder account is created."}
        </small>
      </>}
      {accountMessage && <div className="fp-preview-warning" role="status">{accountMessage}</div>}
      {accountError && <div className="fp-preview-warning" role="alert">{accountError}</div>}
    </div>

    <div style={{marginTop:16,border:"1px solid var(--fp-border, #e5e7eb)",borderRadius:16,padding:16,display:"grid",gap:8}}>
      <div style={{display:"flex",alignItems:"center",gap:9}}><CreditCard size={18}/><b>Virtual card credentials</b></div>
      <p className="fp-muted" style={{margin:0}}>
        No issuer-confirmed virtual card is linked yet. Full card number, CVV/CVC, expiry date and card PIN can appear only through an approved secure issuer flow. FlowPay will not generate or store fake card credentials.
      </p>
      <div className="fp-preview-warning">
        <ShieldCheck size={17}/> Flutterwave's published virtual-card API requires provider approval before use. Card issuance and secure credential reveal remain unavailable until Flutterwave authorizes this FlowPay integration.
      </div>
    </div>

    {loading && <p className="fp-muted">Loading your card records…</p>}
    {error && <div className="fp-preview-warning" role="alert"><AlertCircle size={17}/> {error}</div>}
    {!loading && !error && cards.length === 0 && <div className="fp-empty">
      <CreditCard size={24}/><b>No card records yet</b>
      <span>Your virtual or physical card will appear here after an approved issuer confirms creation.</span>
    </div>}
    {!loading && !error && cards.length > 0 && <div className="fp-feature-list">
      {cards.map(card => <div key={card.id} style={{alignItems:"center",gap:12}}>
        <CreditCard size={20}/>
        <div style={{minWidth:0,flex:1,display:"grid",gap:4}}>
          <b>{card.type === "virtual" ? "Virtual card" : "Physical card"}{card.last4 ? " •••• " + card.last4 : ""}</b>
          <small>{card.provider.replace(/_/g," ")}</small>
          <small>Card number: {card.last4 ? "•••• •••• •••• " + card.last4 : "Not issued"}</small>
          <small>Expiry: {card.expiryMonth && card.expiryYear
            ? String(card.expiryMonth).padStart(2,"0") + "/" + card.expiryYear : "Not available"}</small>
          <small>CVV/CVC: Not stored · Card PIN: issuer-managed; use issuer reset if needed</small>
        </div>
        <span>{card.status}</span>
      </div>)}
    </div>}
  </section>;
}
