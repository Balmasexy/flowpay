import { useMemo, useState } from "react";
import { AlertCircle, Cable, CheckCircle2, Phone, ShieldCheck, Wifi, Zap } from "lucide-react";

const networks = ["MTN", "Airtel", "Glo", "9mobile"];
const electricityProviders = ["IKEDC", "EKEDC", "AEDC", "IBEDC", "KEDCO", "PHED", "Jos Electricity", "KAEDCO"];
const tvProviders = ["DStv", "GOtv", "StarTimes"];

export default function ServicePreview({ path }: { path: string }) {
  const isAirtime = path === "/airtime";
  const isData = path === "/data";
  const isCable = path === "/cable-tv";
  const isTv = path === "/tv";
  const isTelevision = isCable || isTv;
  const title = isAirtime ? "Airtime" : isData ? "Data" : isCable ? "Cable TV" : isTv ? "TV subscriptions" : "Bill payments";
  const [network, setNetwork] = useState("MTN");
  const [provider, setProvider] = useState("");
  const [phone, setPhone] = useState("");
  const [customerRef, setCustomerRef] = useState("");
  const [meterType, setMeterType] = useState("Prepaid");
  const [plan, setPlan] = useState("");
  const [amount, setAmount] = useState("");
  const [review, setReview] = useState(false);
  const [error, setError] = useState("");

  const referenceLabel = isTelevision ? "Smartcard / IUC number" : "Meter / customer account number";
  const referenceValid = /^[A-Za-z0-9-]{5,30}$/.test(customerRef.trim());
  const phoneValid = /^(?:0[0-9]{10}|\+?234[0-9]{10})$/.test(phone.replace(/[\s-]/g, ""));
  const amountValue = Number(amount);
  const amountValid = amount.trim() !== "" && Number.isFinite(amountValue) && amountValue > 0;
  const valid = isAirtime || isData
    ? phoneValid && amountValid && (!isData || plan.trim().length > 0)
    : Boolean(provider) && referenceValid && amountValid;

  const detail = useMemo(() => ({
    provider: isAirtime || isData ? network : provider,
    recipient: isAirtime || isData ? phone.trim() : customerRef.trim(),
    service: isAirtime ? "Airtime top-up" : isData ? "Data bundle" : isTelevision ? "TV subscription" : "Electricity bill",
    plan: isData ? plan.trim() : "",
    meterType: !isAirtime && !isData && !isTelevision ? meterType : ""
  }), [isAirtime, isData, isTelevision, network, phone, plan, provider, customerRef, meterType]);

  function preview() {
    setError("");
    setReview(false);
    if (!valid) {
      setError(isAirtime || isData
        ? "Enter a valid Nigerian phone number and amount" + (isData ? ", and choose a data plan" : "")
        : "Select a provider and enter a valid customer reference and amount");
      return;
    }
    setReview(true);
  }

  const Icon = isAirtime ? Phone : isData ? Wifi : isTelevision ? Cable : Zap;
  return <section className="fp-panel fp-form-panel">
    <div className="fp-form-icon"><Icon/></div>
    <h2>{title}</h2>
    <p className="fp-muted">Prepare and review your service details. This page does not submit a request or debit your FlowPay wallet.</p>

    {(isAirtime || isData) ? <>
      <label>Mobile network</label>
      <div className="fp-network-select">{networks.map(item => <button type="button" key={item} className={network === item ? "selected" : ""} aria-pressed={network === item} onClick={() => { setNetwork(item); setReview(false); }}>{item}</button>)}</div>
      <label htmlFor="service-phone">Phone number</label>
      <input id="service-phone" value={phone} onChange={e => { setPhone(e.target.value); setReview(false); }} inputMode="tel" autoComplete="tel" placeholder="080 0000 0000" maxLength={16}/>
      {isData && <><label htmlFor="service-plan">Data plan / bundle</label><input id="service-plan" value={plan} onChange={e => { setPlan(e.target.value); setReview(false); }} placeholder="Enter plan name or code"/></>}
    </> : <>
      <label htmlFor="service-provider">Service provider</label>
      <select id="service-provider" value={provider} onChange={e => { setProvider(e.target.value); setReview(false); }}>
        <option value="">Select provider</option>
        {(isTelevision ? tvProviders : electricityProviders).map(item => <option key={item} value={item}>{item}</option>)}
      </select>
      {!isTelevision && <>
        <label htmlFor="service-meter-type">Meter type</label>
        <select id="service-meter-type" value={meterType} onChange={e => setMeterType(e.target.value)}><option>Prepaid</option><option>Postpaid</option></select>
      </>}
      <label htmlFor="service-customer-ref">{referenceLabel}</label>
      <input id="service-customer-ref" value={customerRef} onChange={e => { setCustomerRef(e.target.value); setReview(false); }} autoComplete="off" placeholder="Enter customer reference"/>
    </>}

    <label htmlFor="service-amount">Amount (NGN)</label>
    <input id="service-amount" value={amount} onChange={e => { setAmount(e.target.value.replace(/[^0-9.]/g, "")); setReview(false); }} inputMode="decimal" placeholder="₦ 0.00"/>
    {error && <div className="fp-preview-warning"><AlertCircle size={17}/>{error}</div>}
    <button type="button" className="fp-primary" onClick={preview}>Review details</button>
    {review && <div className="fp-panel" style={{ marginTop: 8, padding: 16, boxShadow: "none" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#a95712", fontWeight: 700, fontSize: 12 }}><CheckCircle2 size={17}/> Local preview ready</div>
      <p className="fp-muted">{detail.service} · {detail.provider}</p>
      <p className="fp-muted">Recipient / reference: {detail.recipient}</p>
      {detail.plan && <p className="fp-muted">Plan: {detail.plan}</p>}
      {detail.meterType && <p className="fp-muted">Meter: {detail.meterType}</p>}
      <b>₦{amountValue.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b>
      <p className="fp-muted">Preview only. No provider lookup, bill validation, wallet debit or payment request has occurred.</p>
    </div>}
    <div className="fp-preview-warning"><ShieldCheck size={17}/> Live service payments remain disabled until provider integration, customer verification, authenticated authorization, ledger posting and reconciliation are implemented and tested.</div>
  </section>;
}
