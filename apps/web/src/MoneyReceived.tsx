import { FormEvent, useEffect, useState } from "react";
import { ArrowDownLeft, RefreshCw, ShieldCheck, AlertCircle, Wallet, ExternalLink, CheckCircle2, Clock3 } from "lucide-react";

type DepositStatus = "pending" | "posted" | "failed";
type Deposit = {
  id: string;
  provider: string;
  reference: string;
  amountMinor: string;
  currency: string;
  status: DepositStatus;
  createdAt: string;
  verifiedAt: string | null;
};
type PaystackStatus = {
  reference: string;
  amountMinor: string;
  currency: string;
  status: DepositStatus;
};

function textValue(value: unknown, fallback: string, max = 120): string {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, max)
    : fallback;
}

function parseDeposit(value: unknown, index: number): Deposit | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const rawAmount = row.amountMinor;
  if (
    !(typeof rawAmount === "string" || typeof rawAmount === "number") ||
    !/^\d+$/.test(String(rawAmount)) ||
    !Number.isSafeInteger(Number(rawAmount))
  ) return null;

  const rawCurrency = typeof row.currency === "string" ? row.currency.toUpperCase() : "";
  const currency = /^[A-Z]{3}$/.test(rawCurrency) ? rawCurrency : "NGN";
  const rawStatus = row.status;
  const status: DepositStatus = rawStatus === "posted" || rawStatus === "failed" || rawStatus === "pending"
    ? rawStatus : "pending";

  return {
    id: textValue(row.id, "deposit-" + index, 128),
    provider: textValue(row.provider, "Payment provider"),
    reference: textValue(row.reference, "Reference unavailable"),
    amountMinor: String(rawAmount),
    currency,
    status,
    createdAt: typeof row.createdAt === "string" ? row.createdAt : "",
    verifiedAt: typeof row.verifiedAt === "string" ? row.verifiedAt : null,
  };
}

function formatDate(value: string | null): string {
  if (!value) return "Date unavailable";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleString();
}

function amountToMinor(value: string): string | null {
  const raw = value.trim();
  const match = /^(0|[1-9]\d{0,11})(?:\.(\d{1,2}))?$/.exec(raw);
  if (!match) return null;
  const amount = BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  return amount > 0n && amount <= BigInt(Number.MAX_SAFE_INTEGER) ? amount.toString() : null;
}

function formatAmount(minor: string, currency: string) {
  const value = Number(minor) / 100;
  if (!Number.isFinite(value)) return "Amount unavailable";
  try {
    return new Intl.NumberFormat("en-NG", { style: "currency", currency }).format(value);
  } catch {
    return currency + " " + value.toFixed(2);
  }
}

function statusLabel(status: DepositStatus) {
  return status === "posted" ? "Credited" : status === "failed" ? "Not completed" : "Awaiting verification";
}

export default function MoneyReceived({ token, paymentReturn = false }: { token: string; paymentReturn?: boolean }) {
  const [items, setItems] = useState<Deposit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [amount, setAmount] = useState("");
  const [depositing, setDepositing] = useState(false);
  const [checkoutError, setCheckoutError] = useState("");
  const [paystackEnabled, setPaystackEnabled] = useState(false);
  const [returnDeposit, setReturnDeposit] = useState<PaystackStatus | null>(null);
  const [returnLoading, setReturnLoading] = useState(false);
  const [returnError, setReturnError] = useState("");
  const apiBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") || "";
  const params = new URLSearchParams(window.location.search);
  const returnReference = paymentReturn ? (params.get("reference") || params.get("trxref") || "") : "";

  useEffect(() => {
    let active = true;
    if (!token || !apiBase) {
      setItems([]);
      setError("Your authenticated deposits service is not configured.");
      setLoading(false);
      return () => { active = false; };
    }
    setLoading(true);
    setError("");
    fetch(apiBase + "/customer/money-received", {
      method: "GET",
      credentials: "omit",
      headers: { Authorization: "Bearer " + token },
    })
      .then(async response => {
        const data: unknown = await response.json().catch(() => ({}));
        if (!response.ok) {
          const message = data && typeof data === "object" && "error" in data && typeof data.error === "string"
            ? data.error
            : "Unable to load received payments.";
          throw new Error(message);
        }
        return data;
      })
      .then(data => {
        if (!active) return;
        const root = data && typeof data === "object" ? data as Record<string, unknown> : {};
        const providerConfig = root.depositProviders && typeof root.depositProviders === "object"
          ? root.depositProviders as Record<string, unknown> : {};
        setPaystackEnabled(providerConfig.paystack === true);
        const deposits = root.deposits;
        setItems(Array.isArray(deposits)
          ? deposits.map(parseDeposit).filter((item): item is Deposit => item !== null)
          : []);
      })
      .catch(reason => {
        if (active) {
          setItems([]);
          setPaystackEnabled(false);
          setError(reason instanceof Error ? reason.message : "Unable to load received payments.");
        }
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token, apiBase, refresh]);

  useEffect(() => {
    let active = true;
    if (!paymentReturn || !returnReference || !token || !apiBase) {
      setReturnDeposit(null);
      setReturnLoading(false);
      setReturnError(paymentReturn && !returnReference ? "The payment provider did not return a transaction reference." : "");
      return () => { active = false; };
    }
    setReturnLoading(true);
    setReturnError("");
    const query = new URLSearchParams({ reference: returnReference });
    fetch(apiBase + "/customer/paystack/deposits/status?" + query.toString(), {
      method: "GET",
      credentials: "omit",
      headers: { Authorization: "Bearer " + token }
    }).then(async response => {
      const data: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = data && typeof data === "object" && "error" in data && typeof data.error === "string"
          ? data.error : "Unable to verify the returned payment status.";
        throw new Error(message);
      }
      const deposit = data && typeof data === "object" && "deposit" in data
        ? (data as { deposit?: Record<string, unknown> }).deposit : undefined;
      if (!deposit || typeof deposit.reference !== "string" || typeof deposit.amountMinor !== "string" ||
          typeof deposit.currency !== "string" || !["pending", "posted", "failed"].includes(String(deposit.status))) {
        throw new Error("The payment status response was incomplete.");
      }
      return {
        reference: deposit.reference,
        amountMinor: deposit.amountMinor,
        currency: deposit.currency,
        status: deposit.status as DepositStatus
      };
    }).then(value => {
      if (active) setReturnDeposit(value);
    }).catch(reason => {
      if (active) {
        setReturnDeposit(null);
        setReturnError(reason instanceof Error ? reason.message : "Unable to verify payment status.");
      }
    }).finally(() => { if (active) setReturnLoading(false); });
    return () => { active = false; };
  }, [paymentReturn, returnReference, token, apiBase, refresh]);

  const startPaystackCheckout = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (depositing) return;
    const amountMinor = amountToMinor(amount);
    if (!amountMinor) {
      setCheckoutError("Enter a valid amount greater than ₦0, using no more than two decimal places.");
      return;
    }
    if (!token || !apiBase) {
      setCheckoutError("Your secure FlowPay session or API connection is unavailable.");
      return;
    }
    setDepositing(true);
    setCheckoutError("");
    try {
      const response = await fetch(apiBase + "/customer/paystack/deposits", {
        method: "POST",
        credentials: "omit",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token
        },
        body: JSON.stringify({ amountMinor, idempotencyKey: crypto.randomUUID() })
      });
      const data: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = data && typeof data === "object" && "error" in data && typeof data.error === "string"
          ? data.error : "Paystack checkout could not be started.";
        throw new Error(message);
      }
      const checkoutUrl = data && typeof data === "object" && "checkoutUrl" in data && typeof data.checkoutUrl === "string"
        ? data.checkoutUrl : "";
      let safeCheckoutUrl = false;
      try {
        const parsed = new URL(checkoutUrl);
        safeCheckoutUrl = parsed.protocol === "https:" && parsed.hostname === "checkout.paystack.com";
      } catch {
        safeCheckoutUrl = false;
      }
      if (!safeCheckoutUrl) throw new Error("FlowPay received an invalid Paystack checkout address.");
      window.location.assign(checkoutUrl);
    } catch (reason) {
      setCheckoutError(reason instanceof Error ? reason.message : "Paystack checkout could not be started.");
      setDepositing(false);
    }
  };

  return <section className="fp-panel fp-detail-panel">
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}>
      <div><h2>Money Received</h2><p className="fp-muted">Review your provider deposits and verified wallet credits.</p></div>
      <button type="button" className="fp-outline" onClick={() => setRefresh(value => value + 1)} disabled={loading || returnLoading}><RefreshCw size={15}/> Refresh</button>
    </div>

    {paymentReturn && <div className="fp-preview-warning" role="status" aria-live="polite" style={{display:"grid",gap:7}}>
      <b>{returnLoading ? "Checking Paystack payment…" : returnDeposit?.status === "posted" ? "Paystack test deposit credited" : returnDeposit?.status === "failed" ? "Paystack payment not completed" : "Paystack payment returned"}</b>
      {returnError ? <span><AlertCircle size={15} style={{verticalAlign:"middle"}}/> {returnError}</span> :
        returnDeposit ? <span>{formatAmount(returnDeposit.amountMinor, returnDeposit.currency)} · {statusLabel(returnDeposit.status)}. {returnDeposit.status === "pending" ? "The signed webhook has not yet confirmed the wallet credit. Refresh this page to check again." : returnDeposit.status === "posted" ? "The signed provider verification and balanced FlowPay ledger posting are complete." : "No wallet credit was posted for this attempt."}</span> :
        <span>{returnLoading ? "FlowPay is checking the authenticated transaction reference." : "Use refresh to check the latest verified status."}</span>}
      {returnReference && <small>Reference: {returnReference}</small>}
    </div>}

    <div className="fp-preview-warning"><ShieldCheck size={17}/> Paystack is connected in test mode only. Deposits are credited only after the signed webhook and independent provider verification succeed. No live payment collection is enabled.</div>

    {paystackEnabled ? (
      <form onSubmit={startPaystackCheckout} style={{display:"grid",gap:12,border:"1px solid var(--fp-border, #d8dce3)",borderRadius:14,padding:16,margin:"16px 0"}}>
        <div style={{display:"flex",alignItems:"center",gap:9}}><Wallet size={19}/><b>Add money with Paystack test checkout</b></div>
        <label style={{display:"grid",gap:6,fontWeight:600}}>
          Amount (NGN)
          <input
            type="number" inputMode="decimal" min="0.01" step="0.01" placeholder="Enter amount in naira"
            value={amount} onChange={event => setAmount(event.target.value)}
            disabled={depositing} required
            style={{width:"100%",padding:"12px 13px",borderRadius:9,border:"1px solid var(--fp-border, #cbd1dc)",background:"var(--fp-input-bg, transparent)",color:"inherit",font:"inherit"}}
          />
        </label>
        <small className="fp-muted">You will be redirected to Paystack's hosted checkout. Only a verified test-mode payment can be credited.</small>
        {checkoutError && <div className="fp-preview-warning" role="alert"><AlertCircle size={16}/> {checkoutError}</div>}
        <button type="submit" className="fp-primary" disabled={depositing || !amount.trim()}>
          {depositing ? "Connecting to Paystack…" : <>Continue to Paystack <ExternalLink size={16}/></>}
        </button>
      </form>
    ) : (
      <div className="fp-preview-warning" role="status">
        <AlertCircle size={17}/> Paystack checkout is temporarily unavailable until the test credentials, deposit database migration, and Paystack clearing account are configured on the FlowPay backend.
      </div>
    )}

    {loading && <p className="fp-muted">Loading deposits…</p>}
    {error && <div className="fp-preview-warning"><AlertCircle size={17}/> {error}</div>}
    {!loading && !error && items.length === 0 && <div className="fp-empty"><ArrowDownLeft size={24}/><b>No deposits recorded yet</b><span>Verified Paystack and Flutterwave deposits will appear here. Pending and failed Paystack attempts are also shown for clear tracking.</span></div>}
    {!loading && !error && items.length > 0 && <div className="fp-feature-list">{items.map(item => <div key={item.id} style={{alignItems:"center",gap:12}}>
      {item.status === "posted" ? <CheckCircle2 size={19}/> : item.status === "pending" ? <Clock3 size={19}/> : <AlertCircle size={19}/>}
      <div style={{minWidth:0,flex:1,display:"grid",gap:4}}>
        <b>{formatAmount(item.amountMinor,item.currency)}</b>
        <small>{item.provider} · {item.reference}</small>
        <small>{item.verifiedAt ? "Verified " + formatDate(item.verifiedAt) : "Created " + formatDate(item.createdAt)}</small>
      </div>
      <span>{statusLabel(item.status)}</span>
    </div>)}</div>}
  </section>;
}
