import { useMemo, useState } from "react";
import { Search, ArrowRight, Compass } from "lucide-react";

type Props = { go: (path: string) => void };
const entries = [
  { label: "Overview", path: "/dashboard", description: "Your FlowPay dashboard and account summary", terms: "home dashboard balance" },
  { label: "Deposit / Add Money", path: "/money-received", description: "Add money and review verified wallet deposits", terms: "received deposits funding add money paystack flutterwave" },
  { label: "Transfer History", path: "/money-sent", description: "Review your outgoing wallet transfers", terms: "sent outgoing transfers history" },
  { label: "To FlowPay", path: "/transfers?mode=flowpay", description: "Send money to another FlowPay wallet", terms: "internal wallet account number customer transfer" },\n  { label: "To Bank", path: "/transfers?mode=bank", description: "Verify a Nigerian bank recipient and review a transfer", terms: "bank transfer beneficiary account number bank search" },
  { label: "Cards", path: "/cards", description: "View linked card records", terms: "debit virtual card card issuing provider" },
  { label: "Activity", path: "/activity", description: "Review account activity", terms: "history transactions statement" },
  { label: "Security", path: "/security", description: "Review available account security information", terms: "passkey device security" },
  { label: "Face Verification", path: "/face-verification", description: "Review face and liveness verification", terms: "selfie identity liveness smile id verification" },
  { label: "Bulk Payments", path: "/bulk-payments", description: "Prepare a local bulk-payment file preview", terms: "csv batch payment" },
  { label: "Bulk Verification", path: "/bulk-verification", description: "Validate a bulk file locally", terms: "csv batch verification" },
  { label: "Airtime", path: "/airtime", description: "Prepare an airtime purchase preview", terms: "mobile recharge topup" },
  { label: "Data", path: "/data", description: "Prepare a data-plan preview", terms: "internet bundle" },
  { label: "Bill Payments", path: "/bills", description: "Prepare a utility-bill preview", terms: "electricity utility meter" },
  { label: "Cable TV", path: "/cable-tv", description: "Prepare a cable subscription preview", terms: "dstv gotv startimes" },
  { label: "TV", path: "/tv", description: "Open TV subscription services", terms: "television subscription decoder dstv gotv startimes" },
  { label: "Betting", path: "/betting", description: "Prepare a betting funding preview", terms: "betting gaming account operator funding SportyBet Bet9ja BetKing 1xBet Merrybet NairaBet SureBet" },
  { label: "Savings", path: "/savings", description: "Plan a savings goal", terms: "piggy bank goal" },
  { label: "Fixed Savings", path: "/fixed-savings", description: "Plan a possible fixed-savings term", terms: "lock maturity term" },
  { label: "Spend & Save", path: "/spend-save", description: "Plan monthly spending and savings", terms: "budget income expenses" },
  { label: "Customer Profile", path: "/profile", description: "View and update your customer profile", terms: "personal details photo avatar" },
  { label: "View Account Number", path: "/account-number", description: "Copy your 12-digit FlowPay transfer account number and check virtual bank assignment", terms: "FlowPay internal account number bank nuban virtual account" },
  { label: "Documents", path: "/documents", description: "View required account documents", terms: "nin bvn identity statement" },
  { label: "Invitations", path: "/invitations", description: "Referral services availability", terms: "invite referral friends" },
  { label: "More", path: "/more", description: "Open additional customer services and account shortcuts", terms: "more services shortcuts" },
  { label: "Help & Support", path: "/support", description: "Find account help topics", terms: "complaint failed payment dispute" },
];
export default function FlowPaySearch({ go }: Props) {
  const [query, setQuery] = useState("");
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries.slice(0, 8);
    return entries.filter(item => `${item.label} ${item.description} ${item.terms}`.toLowerCase().includes(q));
  }, [query]);
  return <section className="fp-panel fp-detail-panel">
    <div className="fp-panel-heading"><div><span className="fp-eyebrow">FIND A FLOWPAY FEATURE</span><h2>Search FlowPay</h2><p className="fp-muted">Find account pages and available services. Search does not expose or query private transaction data.</p></div><Compass size={25}/></div>
    <label className="fp-field"><span>Search pages and services</span><div className="fp-search-input"><Search size={18}/><input autoComplete="off" placeholder="Try “cards”, “savings” or “airtime”" value={query} onChange={e=>setQuery(e.target.value)}/></div></label>
    <div className="fp-feature-list">
      {results.map(item=><button type="button" className="fp-search-result" key={item.path} onClick={()=>go(item.path)}><span><b>{item.label}</b><small>{item.description}</small></span><ArrowRight size={17}/></button>)}
      {results.length===0 && <div className="fp-empty-state"><Search size={20}/><b>No matching FlowPay page</b><span>Try another keyword, such as “transfer”, “profile” or “security”.</span></div>}
    </div>
    <p className="fp-muted">Showing {results.length} matching page{results.length===1?"":"s"}.</p>
    <div className="fp-preview-warning" style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}><span>Need help finding or using a FlowPay feature?</span><button type="button" className="fp-outline" onClick={()=>go("/support")}>Open Help &amp; Support <ArrowRight size={15}/></button></div>
  </section>;
}
