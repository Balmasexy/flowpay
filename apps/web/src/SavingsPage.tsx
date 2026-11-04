import { useMemo, useState } from "react";
import { CalendarDays, LockKeyhole, PiggyBank, ShieldCheck, Target } from "lucide-react";

type Props = { mode: "savings" | "fixed" };

const money = (value: number) => new Intl.NumberFormat("en-NG", {
  style: "currency", currency: "NGN", maximumFractionDigits: 2
}).format(value);

export default function SavingsPage({ mode }: Props) {
  const fixed = mode === "fixed";
  const [target, setTarget] = useState("");
  const [contribution, setContribution] = useState("");
  const [term, setTerm] = useState("3");

  const estimate = useMemo(() => {
    const goal = Number(target);
    const monthly = Number(contribution);
    if (!Number.isFinite(goal) || !Number.isFinite(monthly) || goal <= 0 || monthly <= 0) return null;
    return Math.ceil(goal / monthly);
  }, [target, contribution]);

  const validTarget = target.trim() !== "" && Number(target) > 0;
  const validContribution = contribution.trim() !== "" && Number(contribution) > 0;

  return (
    <div className="fp-detail-stack">
      <section className="fp-panel fp-detail-panel">
        <div className="fp-panel-heading">
          <div>
            <span className="fp-eyebrow">{fixed ? "PLANNED TERM DEPOSIT" : "PERSONAL SAVINGS"}</span>
            <h2>{fixed ? "Fixed Savings" : "Savings goals"}</h2>
            <p className="fp-muted">{fixed
              ? "Plan an amount and a possible saving period before fixed-savings products become available."
              : "Plan a savings target and see how regular contributions could add up."}</p>
          </div>
          {fixed ? <LockKeyhole size={25}/> : <PiggyBank size={25}/>}
        </div>
        <div className="fp-preview-warning"><ShieldCheck size={17}/> Savings products are not connected to a verified FlowPay savings provider. This page is a planning preview only; it does not open an account or move money.</div>
        <div className="fp-form-grid">
          <label className="fp-field">
            <span>{fixed ? "Planned principal (NGN)" : "Savings target (NGN)"}</span>
            <input type="number" min="1" step="0.01" inputMode="decimal" placeholder="Enter amount" value={target} onChange={e => setTarget(e.target.value)}/>
          </label>
          <label className="fp-field">
            <span>{fixed ? "Planned monthly contribution (NGN)" : "Monthly contribution (NGN)"}</span>
            <input type="number" min="1" step="0.01" inputMode="decimal" placeholder="Enter amount" value={contribution} onChange={e => setContribution(e.target.value)}/>
          </label>
          {fixed && <label className="fp-field">
            <span>Possible saving period</span>
            <select value={term} onChange={e => setTerm(e.target.value)}>
              <option value="3">3 months</option><option value="6">6 months</option><option value="9">9 months</option><option value="12">12 months</option>
            </select>
          </label>}
        </div>
        <div className="fp-savings-preview">
          <div className="fp-savings-preview-icon">{fixed ? <CalendarDays size={21}/> : <Target size={21}/>}</div>
          <div>
            <b>{fixed ? "Your fixed-savings plan preview" : "Your savings goal preview"}</b>
            {validTarget && validContribution ? <>
              <p>Planned amount: <strong>{money(Number(target))}</strong></p>
              <p>Monthly contribution: <strong>{money(Number(contribution))}</strong></p>
              {fixed && <p>Selected planning period: <strong>{term} months</strong></p>}
              {!fixed && estimate !== null && <p>Estimated time to reach target: <strong>{estimate} month{estimate === 1 ? "" : "s"}</strong></p>}
              <small>{fixed
                ? "This is arithmetic for planning only. No interest, maturity value, or contractual return is available."
                : "Estimate assumes the same contribution every month and excludes interest, fees, and missed contributions."}</small>
            </> : <p className="fp-muted">Enter an amount and monthly contribution to see a simple planning preview.</p>}
          </div>
        </div>
        <div className="fp-feature-list">
          {(fixed
            ? ["No fixed-savings product is currently configured","No confirmed rate, lock period or maturity terms","Early withdrawal and funding are unavailable"]
            : ["No active savings goals are recorded","Recurring debit instructions are not enabled","Savings statements and withdrawals are not available"]
          ).map(item => <div key={item}><ShieldCheck size={17}/>{item}<span>Unavailable</span></div>)}
        </div>
      </section>
    </div>
  );
}
