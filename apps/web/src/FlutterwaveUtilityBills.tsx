import { useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Clock3, RefreshCw, ShieldCheck, Zap } from "lucide-react";

type Biller = { code: string; name: string; description?: string };
type BillItem = {
  code: string; name: string; label: string; amountMinor: string | null;
  feeMinor: string; minimumMinor: string | null; maximumMinor: string | null;
  resolvable: boolean;
};
type ApiRecord = Record<string, unknown>;

function asRecord(value: unknown): ApiRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ApiRecord : {};
}
function toMinor(value: string): string | null {
  const match = /^(0|[1-9]\d{0,8})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const result = BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  return result > 0n && result <= 10_000_000_000n ? result.toString() : null;
}
function naira(minor: string | null | undefined): string {
  if (!minor) return "Not specified";
  const value = BigInt(minor);
  return "₦" + (value / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",") +
    "." + (value % 100n).toString().padStart(2, "0");
}

export default function FlutterwaveUtilityBills({ token }: { token: string }) {
  const apiBase = String(import.meta.env.VITE_API_BASE_URL || "").replace(/\/+$/, "");
  const [billers, setBillers] = useState<Biller[]>([]);
  const [items, setItems] = useState<BillItem[]>([]);
  const [categoryCode, setCategoryCode] = useState("UTILITYBILLS");
  const [billerCode, setBillerCode] = useState("");
  const [itemCode, setItemCode] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [amount, setAmount] = useState("");
  const [transactionPin, setTransactionPin] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerAddress, setCustomerAddress] = useState("");
  const [minimumMinor, setMinimumMinor] = useState<string | null>(null);
  const [maximumMinor, setMaximumMinor] = useState<string | null>(null);
  const [providerFeeMinor, setProviderFeeMinor] = useState("0");
  const [verified, setVerified] = useState(false);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [validationBusy, setValidationBusy] = useState(false);
  const [purchaseBusy, setPurchaseBusy] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [requestId, setRequestId] = useState("");
  const [status, setStatus] = useState("");
  const [tokenValue, setTokenValue] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  const selectedItem = useMemo(() => items.find(item => item.code === itemCode) ?? null, [items, itemCode]);
  const amountMinor = toMinor(amount);
  const activeSession = token.split(".").length === 3 && Boolean(apiBase);
  const billersReady = Boolean(billerCode && billers.some(item => item.code === billerCode));
  const itemsReady = Boolean(selectedItem);
  const amountWithinRange = Boolean(amountMinor) &&
    (!minimumMinor || BigInt(amountMinor!) >= BigInt(minimumMinor)) &&
    (!maximumMinor || BigInt(amountMinor!) <= BigInt(maximumMinor));
  const readyToPurchase = activeSession && billersReady && itemsReady && verified &&
    amountWithinRange && transactionPin.length === 6 && !purchaseBusy && !requestId;

  async function api(path: string, init?: RequestInit): Promise<ApiRecord> {
    const response = await fetch(apiBase + path, {
      credentials: "omit",
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        Authorization: "Bearer " + token,
        ...(init?.body ? { "Content-Type": "application/json" } : {})
      }
    });
    const body = asRecord(await response.json().catch(() => ({})));
    if (!response.ok) throw new Error(typeof body.message === "string" ? body.message :
      typeof body.error === "string" ? body.error : "Flutterwave utility bill request failed.");
    return body;
  }
  function clearOutcome() {
    setError("");
    setNotice("");
    setRequestId("");
    setStatus("");
    setTokenValue("");
    setIdempotencyKey(crypto.randomUUID());
  }
  function clearVerification() {
    setVerified(false);
    setCustomerName("");
    setCustomerAddress("");
    setMinimumMinor(null);
    setMaximumMinor(null);
    setProviderFeeMinor("0");
  }

  useEffect(() => {
    if (!activeSession) { setError("Authenticated FlowPay API is not configured."); return; }
    const controller = new AbortController();
    setCatalogBusy(true);
    setError("");
    fetch(apiBase + "/ready", {
      credentials: "omit", signal: controller.signal,
      headers: { Authorization: "Bearer " + token }
    }).then(async readyResponse => {
      const readyBody = asRecord(await readyResponse.json().catch(() => ({})));
      const payments = asRecord(readyBody.payments);
      const flutterwave = asRecord(payments.flutterwave);
      if (!readyResponse.ok || flutterwave.billPayments !== true) {
        throw new Error("Flutterwave electricity bills are not activated on the FlowPay API yet. The provider environment and database migration must both be ready.");
      }
      const response = await fetch(apiBase + "/customer/flutterwave/bills/categories", {
        credentials: "omit", signal: controller.signal,
        headers: { Authorization: "Bearer " + token }
      });
      const body = asRecord(await response.json().catch(() => ({})));
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Utility bill categories are unavailable.");
      const rows = Array.isArray(body.categories) ? body.categories.map(value => {
        const row = asRecord(value);
        return { code: String(row.code ?? ""), name: String(row.name ?? ""), description: String(row.description ?? "") };
      }).filter(row => row.code) : [];
      const utility = rows.find(row => row.code.toUpperCase() === "UTILITYBILLS");
      if (utility) setCategoryCode(utility.code);
      else throw new Error("Flutterwave has not returned a utility-bills category for Nigeria.");
    }).catch(cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Utility bill categories are unavailable.");
    }).finally(() => { if (!controller.signal.aborted) setCatalogBusy(false); });
    return () => controller.abort();
  }, [apiBase, token, activeSession]);

  useEffect(() => {
    if (!activeSession || !categoryCode) return;
    const controller = new AbortController();
    setCatalogBusy(true);
    setBillers([]);
    setItems([]);
    setBillerCode("");
    setItemCode("");
    clearVerification();
    clearOutcome();
    fetch(apiBase + "/customer/flutterwave/bills/billers?categoryCode=" + encodeURIComponent(categoryCode), {
      credentials: "omit", signal: controller.signal,
      headers: { Authorization: "Bearer " + token }
    }).then(async response => {
      const body = asRecord(await response.json().catch(() => ({})));
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Electricity providers are unavailable.");
      const rows = Array.isArray(body.billers) ? body.billers.map(value => {
        const row = asRecord(value);
        return { code: String(row.code ?? ""), name: String(row.name ?? ""), description: String(row.description ?? "") };
      }).filter(row => row.code && row.name) : [];
      setBillers(rows);
      if (rows.length) setBillerCode(rows[0].code);
      else throw new Error("Flutterwave did not return any supported electricity providers.");
    }).catch(cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Electricity provider list is unavailable.");
    }).finally(() => { if (!controller.signal.aborted) setCatalogBusy(false); });
    return () => controller.abort();
  }, [apiBase, token, activeSession, categoryCode]);

  useEffect(() => {
    if (!activeSession || !billerCode) return;
    const controller = new AbortController();
    setCatalogBusy(true);
    setItems([]);
    setItemCode("");
    clearVerification();
    clearOutcome();
    fetch(apiBase + "/customer/flutterwave/bills/items?billerCode=" + encodeURIComponent(billerCode), {
      credentials: "omit", signal: controller.signal,
      headers: { Authorization: "Bearer " + token }
    }).then(async response => {
      const body = asRecord(await response.json().catch(() => ({})));
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Electricity bill packages are unavailable.");
      const rows = Array.isArray(body.items) ? body.items.map(value => {
        const row = asRecord(value);
        return {
          code: String(row.code ?? ""), name: String(row.name ?? ""), label: String(row.label ?? "Meter number"),
          amountMinor: typeof row.amountMinor === "string" ? row.amountMinor : null,
          feeMinor: typeof row.feeMinor === "string" ? row.feeMinor : "0",
          minimumMinor: typeof row.minimumMinor === "string" ? row.minimumMinor : null,
          maximumMinor: typeof row.maximumMinor === "string" ? row.maximumMinor : null,
          resolvable: row.resolvable === true
        };
      }).filter(row => row.code && row.name) : [];
      setItems(rows);
      if (rows.length) {
        setItemCode(rows[0].code);
        setAmount(rows[0].amountMinor && BigInt(rows[0].amountMinor) > 0n ?
          (Number(rows[0].amountMinor) / 100).toFixed(2) : "");
      } else throw new Error("No electricity bill options were returned for this provider.");
    }).catch(cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Electricity bill options are unavailable.");
    }).finally(() => { if (!controller.signal.aborted) setCatalogBusy(false); });
    return () => controller.abort();
  }, [apiBase, token, activeSession, billerCode]);

  function selectItem(nextCode: string) {
    const next = items.find(item => item.code === nextCode);
    setItemCode(nextCode);
    setAmount(next?.amountMinor && BigInt(next.amountMinor) > 0n ? (Number(next.amountMinor) / 100).toFixed(2) : "");
    clearVerification();
    setProviderFeeMinor(next?.feeMinor ?? "0");
    clearOutcome();
  }
  async function validateMeter() {
    if (!activeSession || !billerCode || !itemCode || customerId.trim().length < 5) {
      setError("Select an electricity provider and bill option, then enter the meter number.");
      return;
    }
    setValidationBusy(true);
    setError("");
    setNotice("");
    clearVerification();
    try {
      const body = await api("/customer/flutterwave/bills/validate", {
        method: "POST",
        body: JSON.stringify({ billerCode, itemCode, customerId: customerId.trim() })
      });
      setVerified(body.verified === true);
      setCustomerName(typeof body.customerName === "string" ? body.customerName : "");
      setCustomerAddress(typeof body.address === "string" ? body.address : "");
      setMinimumMinor(typeof body.minimumMinor === "string" ? body.minimumMinor : selectedItem?.minimumMinor ?? null);
      setMaximumMinor(typeof body.maximumMinor === "string" ? body.maximumMinor : selectedItem?.maximumMinor ?? null);
      setProviderFeeMinor(typeof body.feeMinor === "string" ? body.feeMinor : selectedItem?.feeMinor ?? "0");
      const fixedPrice = selectedItem?.amountMinor;
      if (fixedPrice && BigInt(fixedPrice) > 0n) setAmount((Number(fixedPrice) / 100).toFixed(2));
      setNotice("Flutterwave verified the meter details. Confirm the amount before continuing.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Meter verification failed.");
    } finally { setValidationBusy(false); }
  }
  async function purchase() {
    if (!readyToPurchase || !amountMinor) {
      setError("Verify the meter, confirm the amount, and enter your six-digit transaction PIN.");
      return;
    }
    setPurchaseBusy(true);
    setError("");
    setNotice("");
    try {
      const body = await api("/customer/flutterwave/bills/purchase", {
        method: "POST",
        body: JSON.stringify({
          billerCode, itemCode, customerId: customerId.trim(), amountMinor,
          transactionPin, idempotencyKey
        })
      });
      setRequestId(typeof body.requestId === "string" ? body.requestId : "");
      setStatus(String(body.status ?? "unknown"));
      setTokenValue(typeof body.token === "string" ? body.token : "");
      setNotice(typeof body.message === "string" ? body.message : "Bill payment request submitted.");
      if (["success", "failed"].includes(String(body.status))) setIdempotencyKey(crypto.randomUUID());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Utility bill purchase outcome is unconfirmed.");
    } finally { setPurchaseBusy(false); }
  }
  async function refreshStatus() {
    if (!requestId || !activeSession) return;
    setStatusBusy(true);
    setError("");
    try {
      const body = await api("/customer/flutterwave/bills/status?requestId=" + encodeURIComponent(requestId));
      setStatus(String(body.status ?? "unknown"));
      setTokenValue(typeof body.token === "string" ? body.token : "");
      setNotice(typeof body.message === "string" ? body.message : "Latest Flutterwave bill status received.");
      if (["success", "failed"].includes(String(body.status))) setIdempotencyKey(crypto.randomUUID());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Bill status could not be refreshed.");
    } finally { setStatusBusy(false); }
  }

  return <section className="fp-panel fp-form-panel">
    <div className="fp-form-icon"><Zap/></div>
    <h2>Electricity bill payment</h2>
    <p className="fp-muted">Pay Nigerian prepaid or postpaid electricity bills through Flutterwave using your FlowPay NGN wallet.</p>

    <label htmlFor="flw-electricity-provider">Electricity provider</label>
    <select id="flw-electricity-provider" value={billerCode} onChange={event => {
      setBillerCode(event.target.value); setCustomerId(""); setTransactionPin(""); setAmount("");
      clearVerification(); clearOutcome();
    }} disabled={catalogBusy || billers.length === 0}>
      {billers.length === 0 && <option value="">{catalogBusy ? "Loading providers…" : "No providers available"}</option>}
      {billers.map(item => <option key={item.code} value={item.code}>{item.name}</option>)}
    </select>

    <label htmlFor="flw-electricity-item">Bill type</label>
    <select id="flw-electricity-item" value={itemCode} onChange={event => selectItem(event.target.value)} disabled={catalogBusy || items.length === 0}>
      {items.length === 0 && <option value="">{catalogBusy ? "Loading bill types…" : "Select a provider first"}</option>}
      {items.map(item => <option key={item.code} value={item.code}>{item.name}{item.amountMinor && BigInt(item.amountMinor) > 0n ? " · " + naira(item.amountMinor) : ""}</option>)}
    </select>

    <label htmlFor="flw-electricity-meter">{selectedItem?.label || "Meter number"}</label>
    <input id="flw-electricity-meter" value={customerId} onChange={event => {
      setCustomerId(event.target.value); clearVerification(); clearOutcome();
    }} inputMode="text" autoComplete="off" placeholder="Enter electricity meter number" maxLength={40}/>

    <button type="button" className="fp-outline" onClick={() => void validateMeter()}
      disabled={validationBusy || catalogBusy || !billerCode || !itemCode || customerId.trim().length < 5}>
      {validationBusy ? "Verifying meter…" : "Verify meter with Flutterwave"}
    </button>

    {verified && <div className="fp-bulk-notice">
      <CheckCircle2 size={17}/>
      <span>Verified{customerName ? ": " + customerName : ""}{customerAddress ? " · " + customerAddress : ""}</span>
    </div>}

    <label htmlFor="flw-electricity-amount">Amount (NGN)</label>
    <input id="flw-electricity-amount" value={amount} onChange={event => {
      const raw = event.target.value.replace(/[^0-9.]/g, "");
      const [whole, ...decimals] = raw.split(".");
      setAmount(decimals.length ? whole + "." + decimals.join("").slice(0, 2) : whole);
      clearOutcome();
    }} inputMode="decimal" maxLength={12} placeholder="₦ 0.00"
      readOnly={Boolean(selectedItem?.amountMinor && BigInt(selectedItem.amountMinor) > 0n)}/>
    {verified && <p className="fp-muted">
      {minimumMinor || maximumMinor ? "Allowed range: " + naira(minimumMinor) + " – " + naira(maximumMinor) :
        selectedItem?.amountMinor ? "Flutterwave package amount: " + naira(selectedItem.amountMinor) :
        "Use the amount confirmed by Flutterwave for this meter."}
    </p>}
    {verified && amountMinor && <p className="fp-bulk-notice">
      Service amount: {naira(amountMinor)} · Provider fee: {naira(providerFeeMinor)} · Total wallet debit: {naira((BigInt(amountMinor) + BigInt(providerFeeMinor)).toString())}
    </p>}

    <label htmlFor="flw-electricity-pin">FlowPay transaction PIN</label>
    <input id="flw-electricity-pin" type="password" value={transactionPin}
      onChange={event => setTransactionPin(event.target.value.replace(/\D/g, "").slice(0, 6))}
      inputMode="numeric" maxLength={6} autoComplete="off" placeholder="Enter 6-digit PIN"/>

    {error && <div className="fp-preview-warning"><AlertCircle size={17}/>{error}</div>}
    {notice && <div className="fp-bulk-notice"><CheckCircle2 size={17}/>{notice}</div>}

    <button type="button" className="fp-primary" onClick={() => void purchase()} disabled={!readyToPurchase}>
      {purchaseBusy ? "Submitting to Flutterwave…" : "Authorize and pay"}
    </button>

    {requestId && <div className="fp-panel" style={{ marginTop: 8, padding: 16, boxShadow: "none" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700, fontSize: 12 }}>
        <Clock3 size={17}/> Bill status: {status || "pending"}
      </div>
      <p className="fp-muted">FlowPay request: {requestId}</p>
      {tokenValue && <p className="fp-muted">Electricity token: <strong>{tokenValue}</strong></p>}
      {!["success", "failed"].includes(status) && <button type="button" className="fp-outline" onClick={() => void refreshStatus()} disabled={statusBusy}>
        <RefreshCw size={15}/> {statusBusy ? "Checking Flutterwave…" : "Requery bill status"}
      </button>}
    </div>}

    <div className="fp-preview-warning">
      <ShieldCheck size={17}/> Your FlowPay wallet is debited only after Flutterwave confirms the bill. Pending results keep the amount reserved until status is verified. Live service requires Flutterwave bill-payment approval, a funded source balance and an allowlisted Render server IP.
    </div>
  </section>;
}
