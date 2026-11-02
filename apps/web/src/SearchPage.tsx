import { useMemo, useState } from "react";
import { Search, ArrowDownLeft, ArrowUpRight, CreditCard, Wallet, UserRound, ArrowRight, X } from "lucide-react";

type SearchPageProps = {
  transactions: Array<{ id: string; transaction_type: string; status: string; description: string | null; created_at: string; currency: string; amount_minor: string }>;
  accounts: Array<{ id: string; currency: string; status: string; ledger_balance_minor: string }>;
  cards: Array<{ id: string; card_type: string; status: string; last4: string | null }>;
  profile: { id: string; email: string | null; status: string; created_at: string } | null;
  onNavigate: (page: string) => void;
};

const destinations = [
  { label: "Overview", detail: "Account summary and recent activity" },
  { label: "Activity", detail: "All available account activity" },
  { label: "Money Received", detail: "Incoming ledger transactions" },
  { label: "Money Sent", detail: "Outgoing ledger transactions" },
  { label: "Transfers", detail: "Transfer workflow and recipient checks" },
  { label: "Cards", detail: "Your virtual and physical card records" },
  { label: "Customer Profile", detail: "Your registration and profile details" },
  { label: "View Account Number", detail: "Account identifiers and assignment status" },
  { label: "Security", detail: "Sign-in and account security" },
  { label: "Bulk Payments", detail: "Bulk payment preparation" },
  { label: "Bulk Verification", detail: "Beneficiary file validation" }
];

export default function SearchPage({ transactions, accounts, cards, profile, onNavigate }: SearchPageProps) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all");
  const normalized = query.trim().toLowerCase();

  const results = useMemo(() => {
    if (!normalized) return [];
    const matches: Array<{ id: string; title: string; detail: string; category: string; page: string; icon: "transaction" | "account" | "card" | "profile" | "page" }> = [];
    if (scope === "all" || scope === "transactions") {
      transactions.forEach((tx) => {
        const text = [tx.id, tx.transaction_type, tx.status, tx.description, tx.currency, tx.created_at].join(" ").toLowerCase();
        if (text.includes(normalized)) matches.push({ id: "tx-" + tx.id, title: tx.description || tx.transaction_type, detail: tx.status + " · " + tx.currency + " · " + new Date(tx.created_at).toLocaleString(), category: "Transaction", page: "Activity", icon: "transaction" });
      });
    }
    if (scope === "all" || scope === "accounts") {
      accounts.forEach((account) => {
        const text = [account.id, account.currency, account.status].join(" ").toLowerCase();
        if (text.includes(normalized)) matches.push({ id: "account-" + account.id, title: account.currency + " account", detail: account.status + " · Account reference " + account.id, category: "Account", page: "View Account Number", icon: "account" });
      });
    }
    if (scope === "all" || scope === "cards") {
      cards.forEach((card) => {
        const text = [card.id, card.card_type, card.status, card.last4].join(" ").toLowerCase();
        if (text.includes(normalized)) matches.push({ id: "card-" + card.id, title: card.card_type + " card", detail: card.status + (card.last4 ? " · •••• " + card.last4 : " · Number unavailable"), category: "Card", page: "Cards", icon: "card" });
      });
    }
    if ((scope === "all" || scope === "profile") && profile) {
      const text = [profile.id, profile.email, profile.status, profile.created_at].join(" ").toLowerCase();
      if (text.includes(normalized)) matches.push({ id: "profile-" + profile.id, title: "Customer profile", detail: (profile.email || "Email unavailable") + " · " + profile.status, category: "Profile", page: "Customer Profile", icon: "profile" });
    }
    if (scope === "all" || scope === "pages") {
      destinations.forEach((item) => {
        if ((item.label + " " + item.detail).toLowerCase().includes(normalized)) matches.push({ id: "page-" + item.label, title: item.label, detail: item.detail, category: "Page", page: item.label, icon: "page" });
      });
    }
    return matches.slice(0, 60);
  }, [normalized, scope, transactions, accounts, cards, profile]);

  const Icon = ({ kind }: { kind: string }) => kind === "transaction" ? <ArrowDownLeft size={18} /> : kind === "account" ? <Wallet size={18} /> : kind === "card" ? <CreditCard size={18} /> : kind === "profile" ? <UserRound size={18} /> : <ArrowRight size={18} />;

  return <section className="search-page">
    <div className="panel search-panel">
      <label className="search-input-wrap"><Search size={21} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search transactions, accounts, cards or pages…" aria-label="Search FlowPay" /><button type="button" className="search-clear" onClick={() => setQuery("")} aria-label="Clear search" disabled={!query}><X size={17} /></button></label>
      <div className="search-scope-row" role="group" aria-label="Search category">
        {[["all", "All"], ["transactions", "Transactions"], ["accounts", "Accounts"], ["cards", "Cards"], ["profile", "Profile"], ["pages", "Pages"]].map(([value, label]) => <button type="button" key={value} className={scope === value ? "search-scope search-scope-active" : "search-scope"} onClick={() => setScope(value)}>{label}</button>)}
      </div>
      {!normalized ? <div className="search-empty"><Search size={27} /><strong>Search your FlowPay workspace</strong><span>Find matching records from your authenticated account or jump directly to a workspace page.</span></div> : results.length ? <div className="search-results" aria-live="polite"><div className="search-results-heading"><strong>{results.length} result{results.length === 1 ? "" : "s"}</strong><span>Showing matches from available account data</span></div>{results.map((item) => <button type="button" className="search-result" key={item.id} onClick={() => onNavigate(item.page)}><span className="search-result-icon"><Icon kind={item.icon} /></span><span className="search-result-copy"><strong>{item.title}</strong><small>{item.detail}</small></span><span className="search-result-category">{item.category}</span><ArrowRight size={16} /></button>)}</div> : <div className="search-empty"><Search size={27} /><strong>No matching results</strong><span>Try another keyword or choose a different search category. Search only includes records currently available to your account.</span></div>}
    </div>
    <p className="search-privacy-note">Search is read-only. It does not initiate payments, transfers, card actions, or changes to account data.</p>
  </section>;
}
