import { useEffect, useState } from "react";
import { AlertCircle, Cable, CheckCircle2, Clock3, Phone, RefreshCw, ShieldCheck, Wifi, Zap } from "lucide-react";

type Variation = { code: string; name: string; amount: string };
const networks = [
  { label: "MTN", airtime: "mtn", data: "mtn-data" },
  { label: "Airtel", airtime: "airtel", data: "airtel-data" },
  { label: "Glo", airtime: "glo", data: "glo-data" },
  { label: "9mobile", airtime: "etisalat", data: "etisalat-data" }
];
const electricityProviders = [
  { label: "IKEDC – Ikeja Electric", id: "ikeja-electric" },
  { label: "EKEDC – Eko Electric", id: "eko-electric" },
  { label: "AEDC – Abuja Electric", id: "abuja-electric" },
  { label: "IBEDC – Ibadan Electric", id: "ibadan-electric" },
  { label: "KEDCO – Kano Electric", id: "kano-electric" },
  { label: "PHED – Port Harcourt Electric", id: "portharcourt-electric" },
  { label: "Jos Electric", id: "jos-electric" },
  { label: "Kaduna Electric", id: "kaduna-electric" }
];
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function toMinor(value: string): string | null {
  const match = /^(0|[1-9]\d{0,8})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const amount = BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  return amount > 0n && amount <= BigInt(Number.MAX_SAFE_INTEGER) ? amount.toString() : null;
}

export default function ServicePreview({ path, token }: { path: string; token: string }) {
  const isAirtime = path === "/airtime";
  const isData = path === "/data";
  const isCable = path === "/cable-tv";
  const isTv = path === "/tv";
  const isTelevision = isCable || isTv;
  const isElectricity = path === "/bills";
  const category = isAirtime ? "airtime" : isData ? "data" : "electricity";
  const title = isAirtime ? "Airtime" : isData ? "Data bundles" : isElectricity ? "Electricity / NEPA" : isCable ? "Cable TV" : "TV subscriptions";
  const [network, setNetwork] = useState("MTN");
  const [provider, setProvider] = useState("ikeja-electric");
  const [phone, setPhone] = useState("");
  const [customerRef, setCustomerRef] = useState("");
  const [meterType, setMeterType] = useState("prepaid");
  const [variations, setVariations] = useState<Variation[]>([]);
  const [variationCode, setVariationCode] = useState("");
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [amount, setAmount] = useState("");
  const [transactionPin, setTransactionPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [verificationBusy, setVerificationBusy] = useState(false);
  const [verifiedName, setVerifiedName] = useState("");
  const [verifiedAddress, setVerifiedAddress] = useState("");
  const [meterVerified, setMeterVerified] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [requestId, setRequestId] = useState("");
  const [paymentStatus, setPaymentStatus] = useState("");
  const [statusBusy, setStatusBusy] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const apiBase = String(import.meta.env.VITE_API_BASE_URL || "").replace(/\/+$/, "");
  const selectedNetwork = networks.find(item => item.label === network) ?? networks[0];
  const serviceId = isAirtime ? selectedNetwork.airtime : isData ? selectedNetwork.data : provider;
  const selectedVariation = variations.find(item => item.code === variationCode) ?? null;
  const phoneValid = /^(?:0\d{10}|\+?234\d{10})$/.test(phone.replace(/[\s-]/g, ""));
  const amountValid = isData ? Boolean(selectedVariation) : Boolean(toMinor(amount));
  const readyToPurchase = token.split(".").length === 3 && Boolean(apiBase) && phoneValid && amountValid &&
    (!isElectricity || meterVerified) && transactionPin.length === 6 && !busy;

  useEffect(() => {
    if (!isData && !isElectricity) return;
    if (!token || !apiBase) { setCatalogError("Authenticated FlowPay API is not configured."); return; }
    const controller = new AbortController();
    setCatalogLoading(true); setCatalogError(""); setVariations([]); setVariationCode("");
    const query = new URLSearchParams({ category, serviceID: serviceId });
    fetch(apiBase + "/customer/bills/catalog?" + query.toString(), {
      method: "GET", credentials: "omit", signal: controller.signal,
      headers: { Authorization: "Bearer " + token }
    }).then(async response => {
      const body = asRecord(await response.json().catch(() => ({})));
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Bill catalogue is unavailable.");
      const items = Array.isArray(body.variations) ? body.variations.map(value => {
        const item = asRecord(value);
        return { code: String(item.code ?? ""), name: String(item.name ?? ""), amount: String(item.amount ?? "") };
      }).filter(item => item.code && item.name) : [];
      if (isData && !items.length) throw new Error("No data bundles were returned by VTpass for this network.");
      setVariations(items);
      if (items.length) setVariationCode(items[0].code);
    }).catch(cause => {
      if (!controller.signal.aborted) setCatalogError(cause instanceof Error ? cause.message : "Bill catalogue is unavailable.");
    }).finally(() => { if (!controller.signal.aborted) setCatalogLoading(false); });
    return () => controller.abort();
  }, [category, serviceId, token, apiBase, isData, isElectricity]);

  function resetOutcome() {
    setError(""); setMessage(""); setRequestId(""); setPaymentStatus("");
    setIdempotencyKey(crypto.randomUUID());
  }
  async function verifyMeter() {
    if (!token || !apiBase) { setError("FlowPay API is not configured."); return; }
    if (!customerRef.trim() || !phoneValid) { setError("Enter the meter number and a valid Nigerian contact phone number first."); return; }
    setVerificationBusy(true); setError(""); setMeterVerified(false); setVerifiedName(""); setVerifiedAddress("");
    try {
      const response = await fetch(apiBase + "/customer/bills/validate", {
        method: "POST", credentials: "omit",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ serviceID: provider, customerReference: customerRef.trim(), meterType })
      });
      const body = asRecord(await response.json().catch(() => ({})));
      if (!response.ok || body.verified !== true) throw new Error(typeof body.error === "string" ? body.error : "Electricity meter could not be verified.");
      setVerifiedName(typeof body.customerName === "string" ? body.customerName : "Verified customer");
      setVerifiedAddress(typeof body.address === "string" ? body.address : "");
      setMeterVerified(true);
      setMessage("VTpass confirmed the meter details. Review the amount before paying.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Electricity meter verification failed.");
    } finally { setVerificationBusy(false); }
  }
  async function purchase() {
    if (!readyToPurchase) { setError("Complete all required details and enter your transaction PIN."); return; }
    setBusy(true); setError(""); setMessage(""); setRequestId(""); setPaymentStatus("");
    const payload: Record<string, unknown> = {
      category, serviceID: serviceId, variationCode, customerReference: isElectricity ? customerRef.trim() : "",
      phone, meterType, transactionPin, idempotencyKey,
      ...(isData ? {} : { amountMinor: toMinor(amount) })
    };
    try {
      const response = await fetch(apiBase + "/customer/bills/purchase", {
        method: "POST", credentials: "omit",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify(payload)
      });
      const body = asRecord(await response.json().catch(() => ({})));
      if (typeof body.requestId === "string") setRequestId(body.requestId);
      if (typeof body.status === "string") setPaymentStatus(body.status);
      if (!response.ok && !body.requestId) throw new Error(typeof body.error === "string" ? body.error : "Bill-payment request failed.");
      setMessage(typeof body.message === "string" ? body.message : "Payment request submitted. Check the provider status before retrying.");
      if (["success","failed","reversed"].includes(String(body.status))) setIdempotencyKey(crypto.randomUUID());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Bill-payment outcome could not be confirmed.");
    } finally { setBusy(false); }
  }
  async function refreshStatus() {
    if (!requestId || !apiBase) return;
    setStatusBusy(true); setError("");
    try {
      const response = await fetch(apiBase + "/customer/bills/status?requestId=" + encodeURIComponent(requestId), {
        method: "GET", credentials: "omit", headers: { Authorization: "Bearer " + token }
      });
      const body = asRecord(await response.json().catch(() => ({})));
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Unable to requery this bill payment.");
      setPaymentStatus(String(body.status ?? "unknown"));
      setMessage(typeof body.message === "string" ? body.message : "Latest provider status received.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Status requery failed."); }
    finally { setStatusBusy(false); }
  }

  const Icon = isAirtime ? Phone : isData ? Wifi : isTelevision ? Cable : Zap;
  if (isTelevision) return <section className="fp-panel fp-form-panel">
    <div className="fp-form-icon"><Cable/></div><h2>{title}</h2>
    <p className="fp-muted">Cable and TV subscriptions are not connected to a payment provider yet. This section does not debit your wallet.</p>
    <div className="fp-preview-warning"><ShieldCheck size={17}/> TV subscription provider integration is not enabled.</div>
  </section>;

  return <section className="fp-panel fp-form-panel">
    <div className="fp-form-icon"><Icon/></div>
    <h2>{title}</h2>
    <p className="fp-muted">Provider-connected service purchase. Your wallet is debited only after VTpass confirms delivery; pending outcomes remain reserved until requery.</p>

    {(isAirtime || isData) ? <>
      <label>Mobile network</label>
      <div className="fp-network-select">{networks.map(item => <button type="button" key={item.label} className={network === item.label ? "selected" : ""} aria-pressed={network === item.label} onClick={() => { setNetwork(item.label); resetOutcome(); }}>{item.label}</button>)}</div>
      <label htmlFor="service-phone">Phone number</label>
      <input id="service-phone" value={phone} onChange={event => { setPhone(event.target.value); resetOutcome(); }} inputMode="tel" autoComplete="tel" placeholder="080 0000 0000" maxLength={16}/>
      {isData && <>
        <label htmlFor="service-plan">Data bundle</label>
        <select id="service-plan" value={variationCode} onChange={event => { setVariationCode(event.target.value); resetOutcome(); }} disabled={catalogLoading || variations.length === 0}>
          <option value="">{catalogLoading ? "Loading bundles…" : "Select data bundle"}</option>
          {variations.map(item => <option key={item.code} value={item.code}>{item.name}{Number(item.amount) > 0 ? " – ₦" + Number(item.amount).toLocaleString("en-NG") : ""}</option>)}
        </select>
      </>}
    </> : <>
      <label htmlFor="service-provider">Electricity provider</label>
      <select id="service-provider" value={provider} onChange={event => { setProvider(event.target.value); setMeterVerified(false); resetOutcome(); }}>
        {electricityProviders.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select>
      <label htmlFor="service-meter-type">Meter type</label>
      <select id="service-meter-type" value={meterType} onChange={event => { setMeterType(event.target.value); setMeterVerified(false); resetOutcome(); }}><option value="prepaid">Prepaid</option><option value="postpaid">Postpaid</option></select>
      <label htmlFor="service-customer-ref">Meter number</label>
      <input id="service-customer-ref" value={customerRef} onChange={event => { setCustomerRef(event.target.value); setMeterVerified(false); resetOutcome(); }} autoComplete="off" placeholder="Enter meter / customer number"/>
      <label htmlFor="service-phone">Contact phone number</label>
      <input id="service-phone" value={phone} onChange={event => { setPhone(event.target.value); resetOutcome(); }} inputMode="tel" placeholder="080 0000 0000" maxLength={16}/>
      <button type="button" className="fp-outline" onClick={() => void verifyMeter()} disabled={verificationBusy || !customerRef.trim() || !phoneValid}>
        {verificationBusy ? "Verifying meter…" : "Verify meter with VTpass"}
      </button>
      {meterVerified && <div className="fp-bulk-notice"><CheckCircle2 size={17}/><span>Verified: {verifiedName}{verifiedAddress ? " · " + verifiedAddress : ""}</span></div>}
    </>}

    {!isData && <>
      <label htmlFor="service-amount">Amount (NGN)</label>
      <input id="service-amount" value={amount} onChange={event => { const raw = event.target.value.replace(/[^0-9.]/g, ""); const [whole, ...decimals] = raw.split("."); setAmount(decimals.length ? whole + "." + decimals.join("").slice(0, 2) : whole); resetOutcome(); }} inputMode="decimal" maxLength={12} placeholder="₦ 0.00"/>
    </>}
    {isData && selectedVariation && <p className="fp-muted">Provider price: ₦{Number(selectedVariation.amount).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>}
    {catalogLoading && <p className="fp-muted">Loading provider catalogue…</p>}
    {catalogError && <div className="fp-preview-warning"><AlertCircle size={17}/>{catalogError}</div>}
    <label htmlFor="service-pin">Transaction PIN</label>
    <input id="service-pin" type="password" value={transactionPin} onChange={event => setTransactionPin(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" maxLength={6} autoComplete="off" placeholder="Enter 6-digit PIN"/>

    {error && <div className="fp-preview-warning"><AlertCircle size={17}/>{error}</div>}
    {message && <div className="fp-bulk-notice"><CheckCircle2 size={17}/>{message}</div>}
    <button type="button" className="fp-primary" onClick={() => void purchase()} disabled={!readyToPurchase}>
      {busy ? "Submitting to VTpass…" : "Authorize and pay"}
    </button>
    {requestId && <div className="fp-panel" style={{ marginTop: 8, padding: 16, boxShadow: "none" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700, fontSize: 12 }}><Clock3 size={17}/> Provider request: {paymentStatus || "pending"}</div>
      <p className="fp-muted">Request ID: {requestId}</p>
      {paymentStatus !== "success" && paymentStatus !== "failed" && paymentStatus !== "reversed" && <button type="button" className="fp-outline" onClick={() => void refreshStatus()} disabled={statusBusy}>
        <RefreshCw size={15}/> {statusBusy ? "Checking VTpass…" : "Requery payment status"}
      </button>}
    </div>}
    <div className="fp-preview-warning"><ShieldCheck size={17}/> {isAirtime ? "Airtime" : isData ? "Data" : "Electricity"} payments require VTPASS credentials in the API environment. Live processing also requires the separate VTPASS_LIVE_ENABLED approval switch. Never share provider secrets in the app.</div>
  </section>;
}
