import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { ArrowDownLeft, RefreshCw, ShieldCheck, AlertCircle, ExternalLink, CheckCircle2, Clock3, UploadCloud, FileCheck2 } from "lucide-react";

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
type ReceiptSubmissionStatus = "pending_upload" | "pending_review" | "approved" | "rejected";
type ReceiptSubmission = { id: string; amountMinor: string; currency: string; reference: string | null; fileName: string; status: ReceiptSubmissionStatus; createdAt: string; reviewedAt: string | null; reviewNote: string | null };

function parseReceiptSubmission(value: unknown): ReceiptSubmission | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.amountMinor !== "string" || !/^\d+$/.test(row.amountMinor) || !["pending_upload", "pending_review", "approved", "rejected"].includes(String(row.status))) return null;
  return { id: textValue(row.id, "receipt", 128), amountMinor: row.amountMinor, currency: typeof row.currency === "string" && /^[A-Z]{3}$/.test(row.currency) ? row.currency : "NGN", reference: typeof row.reference === "string" ? row.reference.slice(0, 100) : null, fileName: textValue(row.fileName, "Receipt file", 100), status: row.status as ReceiptSubmissionStatus, createdAt: typeof row.createdAt === "string" ? row.createdAt : "", reviewedAt: typeof row.reviewedAt === "string" ? row.reviewedAt : null, reviewNote: typeof row.reviewNote === "string" ? row.reviewNote.slice(0, 500) : null };
}

function receiptStatusLabel(status: ReceiptSubmissionStatus) {
  return status === "approved" ? "Verified · Credited" : status === "rejected" ? "Rejected · Not credited" : status === "pending_review" ? "Under review" : "Upload incomplete";
}

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
  const [receiptAmount, setReceiptAmount] = useState("");
  const [receiptReference, setReceiptReference] = useState("");
  const [receiptNote, setReceiptNote] = useState("");
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [receiptSending, setReceiptSending] = useState(false);
  const [receiptError, setReceiptError] = useState("");
  const [receiptMessage, setReceiptMessage] = useState("");
  const [receiptRows, setReceiptRows] = useState<ReceiptSubmission[]>([]);
  const [receiptRowsLoading, setReceiptRowsLoading] = useState(false);
  const [receiptRefresh, setReceiptRefresh] = useState(0);
  const [receiptRequestId, setReceiptRequestId] = useState<string | null>(null);
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

  useEffect(() => {
    let active = true;
    if (!token || !apiBase) { setReceiptRows([]); setReceiptRowsLoading(false); return () => { active = false; }; }
    setReceiptRowsLoading(true);
    fetch(apiBase + "/customer/deposit-receipts", { method: "GET", credentials: "omit", headers: { Authorization: "Bearer " + token } })
      .then(async response => {
        const data: unknown = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error("Unable to load receipt submissions.");
        return data;
      })
      .then(data => {
        if (!active) return;
        const root = data && typeof data === "object" ? data as Record<string, unknown> : {};
        setReceiptRows(Array.isArray(root.receipts) ? root.receipts.map(parseReceiptSubmission).filter((item): item is ReceiptSubmission => item !== null) : []);
      })
      .catch(() => { if (active) setReceiptRows([]); })
      .finally(() => { if (active) setReceiptRowsLoading(false); });
    return () => { active = false; };
  }, [token, apiBase, receiptRefresh]);

  const submitReceipt = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (receiptSending) return;
    const amountMinor = amountToMinor(receiptAmount);
    if (!amountMinor) { setReceiptError("Enter a valid NGN amount greater than ₦0."); return; }
    if (!receiptFile) { setReceiptError("Choose a bank transfer receipt image or PDF."); return; }
    if (receiptFile.size < 1 || receiptFile.size > 5 * 1024 * 1024 || !["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(receiptFile.type)) {
      setReceiptError("Use a JPG, PNG, WEBP or PDF file up to 5 MB."); return;
    }
    if (!token || !apiBase) { setReceiptError("Your secure FlowPay session or API connection is unavailable."); return; }
    setReceiptSending(true); setReceiptError(""); setReceiptMessage("");
    const clientRequestId = receiptRequestId || crypto.randomUUID();
    setReceiptRequestId(clientRequestId);
    try {
      const initResponse = await fetch(apiBase + "/customer/deposit-receipts", {
        method: "POST", credentials: "omit",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ clientRequestId, amountMinor, reference: receiptReference.trim() || null, note: receiptNote.trim() || null, fileName: receiptFile.name, contentType: receiptFile.type, sizeBytes: receiptFile.size })
      });
      const initData: unknown = await initResponse.json().catch(() => ({}));
      const initRoot = initData && typeof initData === "object" ? initData as Record<string, unknown> : {};
      if (!initResponse.ok) throw new Error(typeof initRoot.message === "string" ? initRoot.message : typeof initRoot.error === "string" ? initRoot.error : "Receipt upload could not be prepared.");
      const receiptId = typeof initRoot.receiptId === "string" ? initRoot.receiptId : "";
      const uploadUrl = typeof initRoot.uploadUrl === "string" ? initRoot.uploadUrl : "";
      const uploadHeaders = initRoot.uploadHeaders && typeof initRoot.uploadHeaders === "object" ? initRoot.uploadHeaders as Record<string, unknown> : {};
      let safeUploadUrl = false;
      try { const parsed = new URL(uploadUrl); safeUploadUrl = parsed.protocol === "https:" && parsed.hostname.endsWith(".r2.cloudflarestorage.com"); } catch { safeUploadUrl = false; }
      if (!receiptId || !safeUploadUrl || uploadHeaders["Content-Type"] !== receiptFile.type) throw new Error("FlowPay returned an invalid private storage upload address.");
      const uploadResponse = await fetch(uploadUrl, { method: "PUT", credentials: "omit", headers: { "Content-Type": receiptFile.type }, body: receiptFile });
      if (!uploadResponse.ok) throw new Error("The receipt file could not be uploaded. Retry the submission.");
      const completeResponse = await fetch(apiBase + "/customer/deposit-receipts/" + encodeURIComponent(receiptId) + "/complete", {
        method: "POST", credentials: "omit", headers: { Authorization: "Bearer " + token }
      });
      const completeData: unknown = await completeResponse.json().catch(() => ({}));
      const completeRoot = completeData && typeof completeData === "object" ? completeData as Record<string, unknown> : {};
      if (!completeResponse.ok) throw new Error(typeof completeRoot.message === "string" ? completeRoot.message : typeof completeRoot.error === "string" ? completeRoot.error : "The uploaded receipt could not be confirmed. Retry or contact FlowPay support.");
      setReceiptMessage("Receipt uploaded and queued for review. Your wallet will only be credited after the funds are independently verified.");
      setReceiptAmount(""); setReceiptReference(""); setReceiptNote(""); setReceiptFile(null); setReceiptRequestId(null);
      setReceiptRefresh(value => value + 1);
    } catch (reason) {
      setReceiptError(reason instanceof Error ? reason.message : "Receipt upload failed.");
    } finally { setReceiptSending(false); }
  };

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

  return <section className="fp-panel fp-detail-panel fp-money-page">
    <div className="fp-money-hero">
      <div className="fp-money-hero-top">
        <span className="fp-money-brand-mark"><ArrowDownLeft size={22}/></span>
        <span className="fp-money-hero-tag"><ShieldCheck size={13}/> SECURE WALLET FUNDING</span>
        <button type="button" className="fp-money-refresh" onClick={() => setRefresh(value => value + 1)} disabled={loading || returnLoading} aria-label="Refresh deposits"><RefreshCw size={16}/></button>
      </div>
      <span className="fp-money-eyebrow">FLOWPAY · MONEY IN</span>
      <h2>Add money to your wallet</h2>
      <p>Fund your NGN wallet through a protected checkout and track every payment against your verified FlowPay ledger.</p>
      <div className="fp-money-steps"><div><span>01</span><b>Choose amount</b></div><div><span>02</span><b>Pay securely</b></div><div><span>03</span><b>Verify & receive</b></div></div>
    </div>
    {paymentReturn && <div className={`fp-money-result ${returnDeposit?.status === "posted" ? "is-success" : returnDeposit?.status === "failed" ? "is-failed" : "is-pending"}`} role="status" aria-live="polite">
      <div className="fp-money-result-icon">{returnLoading ? <RefreshCw size={20}/> : returnDeposit?.status === "posted" ? <CheckCircle2 size={21}/> : returnDeposit?.status === "failed" ? <AlertCircle size={21}/> : <Clock3 size={21}/>}</div>
      <div className="fp-money-result-copy">
        <b>{returnLoading ? "Checking your payment" : returnDeposit?.status === "posted" ? "Deposit confirmed" : returnDeposit?.status === "failed" ? "Payment not completed" : "Payment received by checkout"}</b>
        {returnError ? <span>{returnError}</span> : returnDeposit ? <span>{formatAmount(returnDeposit.amountMinor, returnDeposit.currency)} · {statusLabel(returnDeposit.status)}. {returnDeposit.status === "pending" ? "The signed provider webhook has not confirmed the wallet credit yet. Refresh to check again." : returnDeposit.status === "posted" ? "Provider verification and the balanced FlowPay ledger posting are complete." : "No wallet credit was posted for this attempt."}</span> : <span>{returnLoading ? "FlowPay is checking the authenticated transaction reference." : "Refresh to check the latest verified status."}</span>}
        {returnReference && <small>Reference: {returnReference}</small>}
      </div>
    </div>}
    <div className="fp-money-content-grid">
      <div className="fp-money-main-column">
        <div className="fp-money-section-heading"><div><span className="fp-money-eyebrow">01 / FUND YOUR WALLET</span><h3>Choose your deposit amount</h3></div><span className="fp-money-currency">NGN ₦</span></div>
        {paystackEnabled ? <form onSubmit={startPaystackCheckout} className="fp-money-checkout">
          <div className="fp-money-provider-head"><span className="fp-money-provider-logo">P</span><div><b>Paystack checkout</b><small>Secure hosted payment · NGN</small></div><span className="fp-money-test-badge">TEST MODE</span></div>
          <label htmlFor="fp-deposit-amount">How much would you like to add?</label>
          <div className="fp-money-amount-input"><span>₦</span><input id="fp-deposit-amount" type="number" inputMode="decimal" min="0.01" step="0.01" placeholder="0.00" value={amount} onChange={event => setAmount(event.target.value)} disabled={depositing} required/></div>
          <div className="fp-money-quick-amounts" aria-label="Suggested deposit amounts">{["1000","5000","10000","20000"].map(value => <button key={value} type="button" className={amount === value ? "selected" : ""} onClick={() => { setAmount(value); setCheckoutError(""); }} disabled={depositing}>₦{Number(value).toLocaleString("en-NG")}</button>)}</div>
          <div className="fp-money-checkout-note"><ShieldCheck size={16}/><span>You will complete payment on Paystack's secure hosted checkout. FlowPay credits your wallet only after the signed webhook and independent provider verification both succeed.</span></div>
          {checkoutError && <div className="fp-preview-warning" role="alert"><AlertCircle size={16}/> {checkoutError}</div>}
          <button type="submit" className="fp-primary fp-money-submit" disabled={depositing || !amount.trim()}>{depositing ? "Connecting to Paystack…" : <>Continue securely <ExternalLink size={16}/></>}</button>
          <small className="fp-money-minor-note">Sandbox transaction · No live customer funds are collected in this environment.</small>
        </form> : <div className="fp-money-unavailable" role="status"><span><AlertCircle size={20}/></span><div><b>Deposit checkout is not available right now</b><p>Paystack test checkout requires the test secret, callback URL, deposit limits, database migration and clearing account to be correctly configured on the FlowPay backend.</p></div></div>}
      </div>
        <form className="fp-money-receipt-form" onSubmit={submitReceipt}>
          <div className="fp-money-receipt-heading">
            <span className="fp-money-receipt-icon"><UploadCloud size={19}/></span>
            <div><span className="fp-money-eyebrow">ALTERNATIVE DEPOSIT</span><h3>Upload a bank transfer receipt</h3><p>Submit your transfer details for a secure review when you paid by bank transfer.</p></div>
          </div>
          <label htmlFor="fp-receipt-amount">Amount transferred (NGN)</label>
          <div className="fp-money-amount-input"><span>₦</span><input id="fp-receipt-amount" type="number" inputMode="decimal" min="0.01" step="0.01" placeholder="0.00" value={receiptAmount} onChange={event => setReceiptAmount(event.target.value)} disabled={receiptSending} required/></div>
          <label htmlFor="fp-receipt-reference">Bank transfer reference (optional)</label>
          <input id="fp-receipt-reference" className="fp-money-receipt-text" value={receiptReference} onChange={event => setReceiptReference(event.target.value)} maxLength={100} placeholder="Enter your bank reference" disabled={receiptSending}/>
          <label htmlFor="fp-receipt-file">Receipt image or PDF</label>
          <input id="fp-receipt-file" className="fp-money-receipt-file" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={event => { setReceiptFile(event.target.files?.[0] ?? null); setReceiptRequestId(null); setReceiptError(""); }} disabled={receiptSending} required/>
          <small className="fp-money-receipt-file-hint">{receiptFile ? receiptFile.name + " · " + (receiptFile.size / 1024 / 1024).toFixed(2) + " MB" : "JPG, PNG, WEBP or PDF · maximum 5 MB"}</small>
          <label htmlFor="fp-receipt-note">Additional details (optional)</label>
          <textarea id="fp-receipt-note" className="fp-money-receipt-textarea" value={receiptNote} onChange={event => setReceiptNote(event.target.value)} maxLength={500} rows={3} placeholder="Add any details that help us identify the transfer." disabled={receiptSending}/>
          <div className="fp-money-checkout-note"><ShieldCheck size={16}/><span>Uploading a receipt does not create an automatic wallet credit. An authorised FlowPay reviewer must independently confirm the matching funds were received before crediting your wallet.</span></div>
          {receiptError && <div className="fp-preview-warning" role="alert"><AlertCircle size={16}/> {receiptError}</div>}
          {receiptMessage && <div className="fp-money-receipt-success" role="status"><CheckCircle2 size={16}/> {receiptMessage}</div>}
          <button type="submit" className="fp-primary fp-money-submit" disabled={receiptSending || !receiptAmount.trim() || !receiptFile}>{receiptSending ? "Uploading receipt…" : <>Submit receipt for review <FileCheck2 size={16}/></>}</button>
        </form>
      <aside className="fp-money-side-column">
        <div className="fp-money-security-card"><span className="fp-money-side-icon"><ShieldCheck size={19}/></span><b>Wallet credit protection</b><p>Payment screenshots or checkout redirects are not proof of payment. A signed provider event and matching transaction verification are required before funds can appear in your available balance.</p><ul><li>Verified provider reference</li><li>Exact amount and currency match</li><li>Duplicate-credit protection</li><li>Balanced ledger posting</li></ul></div>
        <div className="fp-money-help-card"><b>Need help with a deposit?</b><p>Keep your provider reference and contact FlowPay support if a completed checkout is still pending.</p></div>
      </aside>
    </div>
    <div className="fp-money-history">
      <div className="fp-money-history-heading"><div><span className="fp-money-eyebrow">02 / YOUR RECORDS</span><h3>Deposit history</h3><p>Only records linked to your authenticated FlowPay account are shown.</p></div><span className="fp-money-count">{items.length} {items.length === 1 ? "record" : "records"}</span></div>
      {loading && <p className="fp-muted" role="status">Loading your deposit records…</p>}
      {error && <div className="fp-preview-warning" role="alert"><AlertCircle size={17}/> {error}</div>}
      {!loading && !error && items.length === 0 && <div className="fp-empty fp-money-empty"><ArrowDownLeft size={24}/><b>No deposits yet</b><span>Your Paystack and Flutterwave deposit records will appear here with their verified status and reference.</span></div>}
      {!loading && !error && items.length > 0 && <div className="fp-money-history-list">{items.map(item => <article className="fp-money-history-item" key={item.id}>
        <span className={`fp-money-history-icon ${item.status}`}>{item.status === "posted" ? <CheckCircle2 size={18}/> : item.status === "pending" ? <Clock3 size={18}/> : <AlertCircle size={18}/>}</span>
        <div className="fp-money-history-copy"><b>{formatAmount(item.amountMinor,item.currency)}</b><span>{item.provider} · {item.reference}</span><small>{item.verifiedAt ? "Verified " + formatDate(item.verifiedAt) : "Created " + formatDate(item.createdAt)}</small></div>
        <span className={`fp-money-status ${item.status}`}>{statusLabel(item.status)}</span>
      </article>)}</div>}
    </div>
    <div className="fp-money-history fp-money-receipt-history">
      <div className="fp-money-history-heading"><div><span className="fp-money-eyebrow">03 / MANUAL TRANSFER REVIEW</span><h3>Receipt submissions</h3><p>Track uploaded receipts and the authorised review decision.</p></div><span className="fp-money-count">{receiptRows.length} {receiptRows.length === 1 ? "receipt" : "receipts"}</span></div>
      {receiptRowsLoading && <p className="fp-muted" role="status">Loading receipt submissions…</p>}
      {!receiptRowsLoading && receiptRows.length === 0 && <div className="fp-empty fp-money-empty"><FileCheck2 size={22}/><b>No receipt submissions</b><span>Bank transfer receipts you submit will appear here with their review status.</span></div>}
      {!receiptRowsLoading && receiptRows.length > 0 && <div className="fp-money-history-list">{receiptRows.map(item => <article className="fp-money-history-item" key={item.id}>
        <span className={"fp-money-history-icon " + (item.status === "approved" ? "posted" : item.status === "rejected" ? "failed" : "pending")}><FileCheck2 size={18}/></span>
        <div className="fp-money-history-copy"><b>{formatAmount(item.amountMinor, item.currency)}</b><span>{item.fileName}{item.reference ? " · " + item.reference : ""}</span><small>{receiptStatusLabel(item.status)} · Submitted {formatDate(item.createdAt)}</small>{item.reviewNote && <small>Reviewer note: {item.reviewNote}</small>}</div>
        <span className={"fp-money-status " + (item.status === "approved" ? "posted" : item.status === "rejected" ? "failed" : "pending")}>{receiptStatusLabel(item.status)}</span>
      </article>)}</div>}
    </div>
    <div className="fp-money-bottom-note"><ShieldCheck size={15}/> Receipt files are private and visible only to the submitting customer and authorised reviewers. A receipt is not proof of settlement by itself; wallet credits are posted only after an authorised reviewer confirms receipt of the matching funds.</div>
  </section>;
}
