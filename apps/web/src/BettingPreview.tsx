import { useMemo, useState } from "react";
import { AlertCircle, Gift, ShieldCheck, CheckCircle2 } from "lucide-react";

export default function BettingPreview() {
  const [operator, setOperator] = useState("");
  const [accountId, setAccountId] = useState("");
  const [amount, setAmount] = useState("");
  const [review, setReview] = useState(false);
  const [error, setError] = useState("");

  const amountValue = Number(amount);
  const valid = operator.trim().length >= 2 &&
    /^[A-Za-z0-9@._-]{3,50}$/.test(accountId.trim()) &&
    /^\d+(?:\.\d{1,2})?$/.test(amount.trim()) && Number.isFinite(amountValue) && amountValue > 0;

  const summary = useMemo(() => ({
    operator: operator.trim(),
    account: accountId.trim(),
    amount: amountValue
  }), [operator, accountId, amountValue]);

  function preview() {
    setError("");
    setReview(false);
    if (!valid) {
      setError("Enter an operator name, a valid account ID and an amount greater than zero.");
      return;
    }
    setReview(true);
  }

  return <section className="fp-panel fp-form-panel">
    <div className="fp-form-icon"><Gift/></div>
    <h2>Betting wallet funding</h2>
    <p className="fp-muted">Prepare a local funding summary. FlowPay is not connected to a verified betting provider, so this page cannot fund an account.</p>

    <label htmlFor="betting-operator">Betting operator</label>
    <input id="betting-operator" value={operator} onChange={e => { setOperator(e.target.value); setReview(false); }} placeholder="Enter operator name" autoComplete="off" maxLength={60}/>

    <label htmlFor="betting-account">Customer username / account ID</label>
    <input id="betting-account" value={accountId} onChange={e => { setAccountId(e.target.value); setReview(false); }} placeholder="Enter customer account ID" autoComplete="off" maxLength={50}/>

    <label htmlFor="betting-amount">Amount (NGN)</label>
    <input id="betting-amount" value={amount} onChange={e => { setAmount(e.target.value.replace(/[^0-9.]/g, "")); setReview(false); }} inputMode="decimal" placeholder="₦ 0.00"/>

    {error && <div className="fp-preview-warning"><AlertCircle size={17}/>{error}</div>}
    <button type="button" className="fp-primary" onClick={preview}>Review funding details</button>

    {review && <div className="fp-panel" style={{ marginTop: 8, padding: 16, boxShadow: "none" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#a95712", fontWeight: 700, fontSize: 12 }}><CheckCircle2 size={17}/> Local preview ready</div>
      <p className="fp-muted">Operator: {summary.operator}</p>
      <p className="fp-muted">Customer account: {summary.account}</p>
      <b>₦{summary.amount.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b>
      <p className="fp-muted">This is only a draft. No operator lookup, account validation, wallet debit or funding request has occurred.</p>
    </div>}

    <div className="fp-preview-warning"><ShieldCheck size={17}/> Real betting funding is disabled. Do not treat this preview as a completed payment or share your FlowPay PIN, password or OTP.</div>
  </section>;
}
