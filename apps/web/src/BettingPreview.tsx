import { useMemo, useState } from "react";
import { AlertCircle, Gift, ShieldCheck, CheckCircle2 } from "lucide-react";

const OPERATORS = ["SportyBet", "Bet9ja", "BetKing", "1xBet", "Merrybet", "NairaBet", "SureBet"];

export default function BettingPreview() {
  const [operator, setOperator] = useState("");
  const [otherOperator, setOtherOperator] = useState("");
  const [accountId, setAccountId] = useState("");
  const [amount, setAmount] = useState("");
  const [review, setReview] = useState(false);
  const [error, setError] = useState("");

  const selectedOperator = operator === "Other" ? otherOperator.trim() : operator;
  const amountValue = Number(amount);
  const valid = selectedOperator.length >= 2 &&
    /^[A-Za-z0-9@._-]{3,50}$/.test(accountId.trim()) &&
    /^\d+(?:\.\d{1,2})?$/.test(amount.trim()) && Number.isFinite(amountValue) && amountValue > 0;

  const summary = useMemo(() => ({
    operator: selectedOperator,
    account: accountId.trim(),
    amount: amountValue
  }), [selectedOperator, accountId, amountValue]);

  function preview() {
    setError("");
    setReview(false);
    if (!valid) {
      setError("Choose a betting operator, enter a valid account ID and an amount greater than zero.");
      return;
    }
    setReview(true);
  }

  return <section className="fp-panel fp-form-panel">
    <div className="fp-form-icon"><Gift/></div>
    <h2>Betting wallet funding</h2>
    <p className="fp-muted">Choose your betting operator and prepare a funding summary. Provider lookup and funding are not connected, so this page cannot debit your FlowPay wallet or credit a betting account.</p>

    <label htmlFor="betting-operator">Betting operator</label>
    <select id="betting-operator" value={operator} onChange={e => { setOperator(e.target.value); setReview(false); }} autoComplete="off">
      <option value="">Select betting operator</option>
      {OPERATORS.map(name => <option key={name} value={name}>{name}</option>)}
      <option value="Other">Other operator</option>
    </select>
    {operator === "Other" && <>
      <label htmlFor="betting-other-operator">Operator name</label>
      <input id="betting-other-operator" value={otherOperator} onChange={e => { setOtherOperator(e.target.value); setReview(false); }} placeholder="Enter operator name" autoComplete="off" maxLength={60}/>
    </>}

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

    <div className="fp-preview-warning"><ShieldCheck size={17}/> Real betting funding remains disabled until a verified provider integration, customer validation and ledger posting controls are available. Do not treat this preview as a completed payment.</div>
  </section>;
}
