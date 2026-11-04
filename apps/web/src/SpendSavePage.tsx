import { useMemo, useState } from "react";
import { PiggyBank, ShieldCheck, Wallet } from "lucide-react";

const money = (value: number) => new Intl.NumberFormat("en-NG", {
  style: "currency", currency: "NGN", maximumFractionDigits: 2
}).format(value);

export default function SpendSavePage() {
  const [income, setIncome] = useState("");
  const [spending, setSpending] = useState("");
  const [saving, setSaving] = useState("");

  const validAmount = (value: string, allowZero = false) => {
    const trimmed = value.trim();
    if (!/^(?:\d+)(?:\.\d{1,2})?$/.test(trimmed)) return false;
    const amount = Number(trimmed);
    return Number.isFinite(amount) && (allowZero ? amount >= 0 : amount > 0) &&
      amount <= Number.MAX_SAFE_INTEGER;
  };

  const ready = validAmount(income) && validAmount(spending, true) && validAmount(saving, true);

  const result = useMemo(() => {
    if (!ready) return null;
    const monthlyIncome = Number(income);
    const monthlySpending = Number(spending);
    const monthlySaving = Number(saving);
    const total = monthlySpending + monthlySaving;
    const remaining = monthlyIncome - total;
    if (!Number.isFinite(total) || !Number.isFinite(remaining)) return null;
    return { remaining, total };
  }, [income, spending, saving, ready]);

  return <div className="fp-detail-stack">
    <section className="fp-panel fp-detail-panel">
      <div className="fp-panel-heading">
        <div>
          <span className="fp-eyebrow">PERSONAL MONEY PLANNER</span>
          <h2>Spend &amp; Save</h2>
          <p className="fp-muted">Plan how to divide an income amount between spending and savings before any automated feature is enabled.</p>
        </div>
        <Wallet size={25}/>
      </div>
      <div className="fp-preview-warning"><ShieldCheck size={17}/> This is a private, on-screen planning calculator. It does not read or debit your FlowPay balance, create standing orders, or move money.</div>
      <div className="fp-form-grid">
        <label className="fp-field"><span>Planned monthly income (NGN)</span><input type="number" min="0" step="0.01" inputMode="decimal" placeholder="Enter income" value={income} onChange={e => setIncome(e.target.value)}/>
          {income.trim() !== "" && !validAmount(income) && <small className="fp-error">Enter a positive amount with no more than 2 decimal places.</small>}</label>
        <label className="fp-field"><span>Planned monthly spending (NGN)</span><input type="number" min="0" step="0.01" inputMode="decimal" placeholder="Enter spending budget" value={spending} onChange={e => setSpending(e.target.value)}/>
          {spending.trim() !== "" && !validAmount(spending, true) && <small className="fp-error">Enter zero or a positive amount with no more than 2 decimal places.</small>}</label>
        <label className="fp-field"><span>Planned monthly savings (NGN)</span><input type="number" min="0" step="0.01" inputMode="decimal" placeholder="Enter savings target" value={saving} onChange={e => setSaving(e.target.value)}/>
          {saving.trim() !== "" && !validAmount(saving, true) && <small className="fp-error">Enter zero or a positive amount with no more than 2 decimal places.</small>}</label>
      </div>
      <div className="fp-savings-preview">
        <div className="fp-savings-preview-icon"><PiggyBank size={21}/></div>
        <div>
          <b>Your monthly allocation preview</b>
          {ready && result ? <>
            <p>Income entered: <strong>{money(Number(income))}</strong></p>
            <p>Spending + savings: <strong>{money(result.total)}</strong></p>
            <p>Unallocated amount: <strong>{money(result.remaining)}</strong></p>
            <small>{result.remaining < 0 ? "Your planned spending and savings exceed the income entered. Adjust the figures before using this plan." : "This calculation uses only the figures you entered; it is not a verified account balance or transaction."}</small>
          </> : <p className="fp-muted">Enter all three amounts to calculate your planned allocation.</p>}
        </div>
      </div>
      <div className="fp-feature-list">
        {["Automatic round-ups are not connected","Scheduled transfers to savings are not enabled","Spending alerts and category tracking are not connected","No real balance or transaction history is changed"].map(item => <div key={item}><ShieldCheck size={17}/>{item}<span>Preview only</span></div>)}
      </div>
    </section>
  </div>;
}
