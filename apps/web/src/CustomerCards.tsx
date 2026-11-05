import { useEffect, useState } from "react";
import { Building2, Check, Copy, CreditCard, RefreshCw, ShieldCheck, AlertCircle } from "lucide-react";

type VirtualBankAccount = {
  assigned: boolean;
  accountNumber: string | null;
  bankName: string | null;
  accountName: string | null;
};
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

const CARD_STATUSES = new Set<Card["status"]>(["pending", "active", "frozen", "blocked", "closed", "failed"]);

function parseCards(value: unknown): Card[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): Card[] => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Record<string, unknown>;
    if (typeof raw.id !== "string" || !raw.id.trim()) return [];
    const month = typeof raw.expiryMonth === "number" && Number.isInteger(raw.expiryMonth) && raw.expiryMonth >= 1 && raw.expiryMonth <= 12 ? raw.expiryMonth : null;
    const year = typeof raw.expiryYear === "number" && Number.isInteger(raw.expiryYear) && raw.expiryYear >= 2000 && raw.expiryYear <= 2200 ? raw.expiryYear : null;
    return [{
      id: raw.id,
      provider: typeof raw.provider === "string" && raw.provider.trim() ? raw.provider : "Card provider",
      type: raw.type === "physical" ? "physical" : "virtual",
      status: typeof raw.status === "string" && CARD_STATUSES.has(raw.status as Card["status"]) ? raw.status as Card["status"] : "pending",
      last4: typeof raw.last4 === "string" && /^\d{4}$/.test(raw.last4) ? raw.last4 : null,
      expiryMonth: month,
      expiryYear: year,
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : ""
    }];
  });
}

type VirtualBankAccount = {
  assigned: boolean;
  status: string;
  accountNumber: string | null;
  bankName: string | null;
  accountName: string | null;
};

function parseVirtualBankAccount(value: unknown): VirtualBankAccount {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const assigned = raw.assigned === true &&
    typeof raw.accountNumber === "string" && /^[0-9]{10}$/.test(raw.accountNumber) &&
    typeof raw.bankName === "string" && !!raw.bankName.trim() &&
    typeof raw.accountName === "string" && !!raw.accountName.trim();
  return {
    assigned,
    status: typeof raw.status === "string" ? raw.status : assigned ? "assigned" : "not_requested",
    accountNumber: assigned ? raw.accountNumber as string : null,
    bankName: assigned ? raw.bankName as string : null,
    accountName: assigned ? raw.accountName as string : null
  };
}

export default function CustomerCards({ token }: { token: string }) {
  const [cards, setCards] = useState<Card[]>([]);
  const [cardholderName, setCardholderName] = useState<string | null>(null);
  const [virtualBankAccount, setVirtualBankAccount] = useState<VirtualBankAccount>({
    assigned: false, status: "not_requested", accountNumber: null, bankName: null, accountName: null
  });
  const [accountConsent, setAccountConsent] = useState(false);
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountError, setAccountError] = useState("");
  const [accountMessage, setAccountMessage] = useState("");
  const [copied, setCopied] = useState(false);
  const [virtualBankAccount, setVirtualBankAccount] = useState<VirtualBankAccount>({
    assigned: false, accountNumber: null, bankName: null, accountName: null
  });
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const apiBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") || "";

  useEffect(() => {
    let active = true;
    if (!token || !apiBase) {
      setCards([]);
      setCardholderName(null);
      setVirtualBankAccount({ assigned: false, accountNumber: null, bankName: null, accountName: null });
      setError("Your authenticated cards service is not configured.");
      setLoading(false);
      return () => { active = false; };
    }
    setCardholderName(null);
    setLoading(true);
    setError("");
    Promise.all([
      fetch(apiBase + "/customer/cards", {
        method: "GET", credentials: "omit",
        headers: { Authorization: "Bearer " + token }
      }),
      fetch(apiBase + "/customer/account-details", {
        method: "GET", credentials: "omit",
        headers: { Authorization: "Bearer " + token }
      })
    ]).then(async ([cardResponse, accountResponse]) => {
      const [cardData, accountData] = await Promise.all([
        cardResponse.json().catch(() => ({})),
        accountResponse.json().catch(() => ({}))
      ]);
      if (!cardResponse.ok) {
        const body = cardData && typeof cardData === "object" ? cardData as Record<string, unknown> : {};
        throw new Error(typeof body.error === "string" ? body.error : "Unable to load cards.");
      }
      if (!accountResponse.ok) {
        const body = accountData && typeof accountData === "object" ? accountData as Record<string, unknown> : {};
        throw new Error(typeof body.error === "string" ? body.error : "Unable to load your virtual bank account.");
      }
      return { cardData, accountData };
    }).then(({ cardData, accountData }) => {
      if (active) {
        const responseBody = cardData && typeof cardData === "object" ? cardData as Record<string, unknown> : {};
        const accountBody = accountData && typeof accountData === "object" ? accountData as Record<string, unknown> : {};
        const virtual = accountBody.virtualBankAccount && typeof accountBody.virtualBankAccount === "object"
          ? accountBody.virtualBankAccount as Record<string, unknown> : {};
        const assigned = virtual.assigned === true &&
          typeof virtual.accountNumber === "string" && /^\\d{10}$/.test(virtual.accountNumber) &&
          typeof virtual.bankName === "string" && typeof virtual.accountName === "string";
        setVirtualBankAccount({
          assigned,
          accountNumber: assigned ? virtual.accountNumber as string : null,
          bankName: assigned ? virtual.bankName as string : null,
          accountName: assigned ? virtual.accountName as string : null
        });
        setCardholderName(typeof responseBody.cardholderName === "string" && responseBody.cardholderName.trim()
          ? responseBody.cardholderName.trim().slice(0, 100) : null);
        setCards(parseCards(responseBody.cards));
        setVirtualBankAccount(parseVirtualBankAccount(responseBody.virtualBankAccount));
      }
    }).catch(reason => {
      if (active) {
        setCards([]);
        setCardholderName(null);
        setVirtualBankAccount({ assigned: false, accountNumber: null, bankName: null, accountName: null });
        setError(reason instanceof Error ? reason.message : "Unable to load cards.");
      }
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token, apiBase, refresh]);

  const copyVirtualAccount = async () => {
    if (!virtualBankAccount.accountNumber) return;
    try {
      await navigator.clipboard.writeText(virtualBankAccount.accountNumber);
      setCopied(true);
    } catch { setCopied(false); }
  };

  const requestVirtualBankAccount = async () => {
    if (accountBusy || !accountConsent) return;
    setAccountBusy(true);
    setAccountError("");
    setAccountMessage("");
    try {
      const response = await fetch(apiBase + "/customer/dedicated-bank-account", {
        method: "POST", credentials: "omit",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ consent: true })
      });
      const body: unknown = await response.json().catch(() => ({}));
      const data = body && typeof body === "object" ? body as Record<string, unknown> : {};
      if (!response.ok && response.status !== 202) {
        throw new Error(typeof data.message === "string" ? data.message :
          typeof data.error === "string" ? data.error : "Unable to request a virtual bank account.");
      }
      const account = parseVirtualBankAccount(data.virtualBankAccount);
      setVirtualBankAccount(account);
      setAccountMessage(typeof data.message === "string" ? data.message :
        account.assigned ? "Paystack confirmed your test virtual bank account." :
          "Paystack is processing the test virtual bank account request.");
      setAccountConsent(false);
      setRefresh(value => value + 1);
    } catch (cause) {
      setAccountError(cause instanceof Error ? cause.message : "Unable to request a virtual bank account.");
    } finally { setAccountBusy(false); }
  };

  const copyVirtualAccount = async () => {
    if (!virtualBankAccount.accountNumber) return;
    try {
      await navigator.clipboard.writeText(virtualBankAccount.accountNumber);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setAccountError("Clipboard unavailable. You can select and copy the account number manually.");
    }
  };

  return <section className="fp-panel fp-detail-panel">
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}>
      <div><h2>Cards</h2><p className="fp-muted">View issued card records and your provider-confirmed bank account.</p></div>
      <button type="button" className="fp-outline" onClick={() => setRefresh(value => value + 1)} disabled={loading}><RefreshCw size={15}/> Refresh</button>
    </div>
    <div className="fp-detail-list">
      <div><span>Cardholder name</span><b>{cardholderName || "Not available on this profile"}</b></div>
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
        <p className="fp-muted" style={{margin:0}}>This is a Paystack-issued bank account for receiving NGN bank transfers. It is separate from your 10-digit FlowPay wallet number and from your card number.</p>
        <label style={{display:"flex",alignItems:"flex-start",gap:9,fontSize:13,lineHeight:1.45}}>
          <input type="checkbox" checked={accountConsent} onChange={event => setAccountConsent(event.target.checked)} style={{marginTop:3}}/>
          <span>I consent to FlowPay sending my registered full name, email address and phone number to Paystack to request a dedicated NGN virtual bank account for this profile.</span>
        </label>
        <button type="button" className="fp-primary" disabled={!accountConsent || accountBusy || loading}
          onClick={() => void requestVirtualBankAccount()}>
          {accountBusy ? "Requesting with Paystack…" : "Request test virtual bank account"}
        </button>
        <small className="fp-muted">Sandbox only. Paystack must accept and confirm the assignment before an account number is shown. Financial-services eligibility or identity validation may be required.</small>
      </>}
      {accountMessage && <div className="fp-preview-warning" role="status">{accountMessage}</div>}
      {accountError && <div className="fp-preview-warning" role="alert">{accountError}</div>}
    </div>
    <div style={{marginTop:16,border:"1px solid var(--fp-border, #e5e7eb)",borderRadius:16,padding:16,display:"grid",gap:8}}>
      <div style={{display:"flex",alignItems:"center",gap:9}}><CreditCard size={18}/><b>Virtual card credentials</b></div>
      <p className="fp-muted" style={{margin:0}}>No issuer-confirmed virtual card is linked yet. The full card number, CVV, expiry date and card PIN will appear only through an approved, secure card-issuer details flow. FlowPay will not generate or store fake card credentials.</p>
      <div className="fp-preview-warning"><ShieldCheck size={17}/> Flutterwave's published virtual-card API requires provider approval before use. Card issuance and secure credential reveal remain unavailable until Flutterwave authorizes this FlowPay integration.</div>
    </div>
    <div className="fp-account-type-card fp-account-bank-card" style={{marginTop:16}}>
      <div style={{display:"flex",alignItems:"center",gap:10}}><CreditCard size={19}/><b>Virtual bank account</b></div>
      {virtualBankAccount.assigned ? <>
        <p className="fp-muted">Paystack-confirmed NGN dedicated account. This is for bank transfers, not a card number.</p>
        <div className="fp-account-type-value">{virtualBankAccount.accountNumber}</div>
        <div className="fp-account-bank-details"><span>Bank</span><b>{virtualBankAccount.bankName}</b><span>Account name</span><b>{virtualBankAccount.accountName}</b></div>
        <button type="button" className="fp-outline" onClick={() => void copyVirtualAccount()}><CreditCard size={14}/> Copy virtual account number</button>
        {copied && <small className="fp-muted" role="status">Virtual account number copied.</small>}
      </> : <>
        <p className="fp-muted">No Paystack-issued dedicated bank account is confirmed for this profile. The 10-digit To FlowPay number is separate and cannot receive transfers from other banks.</p>
        <span className="fp-account-live-label is-pending"><ShieldCheck size={14}/> Awaiting provider eligibility and assignment</span>
      </>}
    </div>
    <div className="fp-preview-warning"><ShieldCheck size={17}/> Card details appear only after an approved issuer confirms issuance. FlowPay does not create card numbers or store CVV/CVC or card PIN values. A card PIN can be set or changed through an issuer-approved flow; an existing PIN cannot be revealed.</div>
    {loading && <p className="fp-muted">Loading your card records…</p>}
    {error && <div className="fp-preview-warning"><AlertCircle size={17}/> {error}</div>}
    {!loading && !error && cards.length === 0 && <div className="fp-empty"><CreditCard size={24}/><b>No card records yet</b><span>Your virtual or physical card will appear here after a verified card-issuing workflow creates it.</span></div>}
    {!loading && !error && cards.length > 0 && <div className="fp-feature-list">
      {cards.map(card => <div key={card.id} style={{alignItems:"center",gap:12}}>
        <CreditCard size={20}/>
        <div style={{minWidth:0,flex:1,display:"grid",gap:4}}>
          <b>{card.type === "virtual" ? "Virtual card" : "Physical card"}{card.last4 ? " •••• " + card.last4 : ""}</b>
          <small>{card.provider.replace(/_/g," ")}</small>
          <small>Card number: {card.last4 ? "•••• •••• •••• " + card.last4 : "Not issued"}</small>
          <small>Expiry: {card.expiryMonth && card.expiryYear ? String(card.expiryMonth).padStart(2,"0") + "/" + card.expiryYear : "Not available"}</small>
          <small>CVV/CVC: Not stored by FlowPay · Card PIN: Hidden; issuer reset only</small>
        </div>
        <span>{card.status}</span>
      </div>)}
    </div>}
  </section>;
}
