import { useCallback, useEffect, useState } from "react";
import {
  Activity, ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Cable, ChevronRight,
  Clock3, CreditCard, FileText, Phone, ShieldCheck, Wallet, Wifi, Zap
} from "lucide-react";

type AccountSummary = { currency: string; status: string; count: number };
type ActivityItem = {
  id: string; type: string; description: string; status: "posted" | "reversed";
  createdAt: string; postedAt: string | null;
};
type Overview = {
  accounts: AccountSummary[];
  recentActivity: ActivityItem[];
  balance: { available: false; reason: string };
  paymentsEnabled: false;
  generatedAt: string;
};

const services = [
  { label: "Airtime", path: "/airtime", icon: Phone, detail: "Top up any Nigerian network" },
  { label: "Data", path: "/data", icon: Wifi, detail: "Buy data bundles" },
  { label: "Transfers", path: "/transfers", icon: ArrowLeftRight, detail: "Manage transfer services" },
  { label: "Cards", path: "/cards", icon: CreditCard, detail: "Manage card services" },
  { label: "Electricity", path: "/bills", icon: Zap, detail: "Electricity bill services" },
  { label: "Cable TV", path: "/cable-tv", icon: Cable, detail: "TV subscription services" },
  { label: "Savings", path: "/savings", icon: Wallet, detail: "Savings tools and goals" },
  { label: "History", path: "/activity", icon: Clock3, detail: "Review verified activity" },
];

const providers = ["MTN", "Airtel", "Glo", "9mobile"];

function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleString();
}

function titleCase(value: string) {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, letter => letter.toUpperCase());
}

export default function OverviewDashboard({ token, go, network, onNetworkChange }: {
  token: string; go: (path: string) => void; network: string; onNetworkChange: (network: string) => void;
}) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadOverview = useCallback(async () => {
    if (!token || token.split(".").length !== 3) {
      setOverview(null); setError("Your secure session is not ready. Refresh after signing in again."); setLoading(false); return;
    }
    setLoading(true); setError("");
    const apiBase = String(import.meta.env.VITE_API_BASE_URL || "").replace(/\/+$/, "");
    if (!apiBase) { setError("FlowPay API address is not configured."); setLoading(false); return; }
    try {
      const response = await fetch(apiBase + "/customer/overview", {
        method: "GET", credentials: "omit", headers: { Authorization: "Bearer " + token }
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(response.status === 401 ? "Your session has expired. Please sign in again." : data.error || "Unable to load your account overview.");
      setOverview(data.overview as Overview);
    } catch (cause) {
      setOverview(null);
      setError(cause instanceof Error ? cause.message : "Unable to load your account overview.");
    } finally { setLoading(false); }
  }, [token]);

  useEffect(() => { void loadOverview(); }, [loadOverview]);

  const accountCount = overview?.accounts.reduce((total, account) => total + account.count, 0) ?? 0;
  const activeAccountCount = overview?.accounts.filter(account => account.status === "active").reduce((total, account) => total + account.count, 0) ?? 0;
  const currencies = [...new Set(overview?.accounts.filter(account => account.status === "active").map(account => account.currency) ?? [])];

  return <>
    <section className="fp-balance">
      <div className="fp-balance-top"><span>Available balance</span><Wallet size={20}/></div>
      <strong className="fp-balance-unavailable" role="status" aria-live="polite">Not available</strong>
      <small>Live ledger balance display is not yet enabled. FlowPay will not show an estimated or sample amount.</small>
      <div className="fp-balance-actions">
        <button onClick={() => go("/transfers")}><ArrowDownLeft size={17}/> Add money</button>
        <button onClick={() => go("/transfers")}><ArrowUpRight size={17}/> Send money</button>
      </div>
    </section>

    <section className="fp-overview-grid" aria-label="Account overview">
      <article className="fp-overview-card fp-account-summary-card">
        <div className="fp-overview-card-heading"><span className="fp-overview-icon"><Wallet size={19}/></span><span>Account summary</span></div>
        {loading ? <p className="fp-overview-muted">Loading your account records…</p> : error ? <p className="fp-overview-muted">Account summary is temporarily unavailable.</p> : <>
          <div className="fp-overview-stat-row"><div><strong>{accountCount}</strong><span>Customer accounts</span></div><div><strong>{activeAccountCount}</strong><span>Active accounts</span></div></div>
          <div className="fp-overview-currencies"><span>Active account currencies</span><b>{currencies.length ? currencies.join(" · ") : "No active account assigned"}</b></div>
        </>}
        <button className="fp-overview-link" onClick={() => go("/account-number")}>Account information <ChevronRight size={15}/></button>
      </article>
      <article className="fp-overview-card fp-account-safety-card">
        <div className="fp-overview-card-heading"><span className="fp-overview-icon"><ShieldCheck size={19}/></span><span>Account services</span></div>
        <strong className="fp-overview-service-status">Payments are currently disabled</strong>
        <p className="fp-overview-muted">Transfers and provider payments remain unavailable until secure verification, ledger posting and reconciliation are enabled.</p>
        <button className="fp-overview-link" onClick={() => go("/security")}>Security centre <ChevronRight size={15}/></button>
      </article>
    </section>

    <section className="fp-section">
      <div className="fp-section-title"><h2>Quick services</h2><span>Open a FlowPay service</span></div>
      <div className="fp-service-grid">
        {services.map(({label,path,icon:Icon,detail}) => <button className="fp-service-tile" key={path} onClick={() => go(path)}>
          <span className="fp-service-icon"><Icon size={21}/></span><b>{label}</b><small>{detail}</small>
        </button>)}
      </div>
    </section>

    <section className="fp-section">
      <div className="fp-section-title"><h2>Mobile networks</h2><span>Select a network for airtime or data</span></div>
      <div className="fp-network-row">{providers.map(provider => <button key={provider} className={network === provider ? "fp-network selected" : "fp-network"} aria-pressed={network === provider} onClick={() => { onNetworkChange(provider); go("/airtime"); }}>{provider}</button>)}</div>
    </section>

    <section className="fp-section fp-overview-activity">
      <div className="fp-section-title"><h2>Recent activity</h2><button onClick={() => go("/activity")}>See all <ChevronRight size={15}/></button></div>
      {loading ? <div className="fp-overview-state"><Clock3 size={22}/><span>Loading verified activity…</span></div> : error ? <div className="fp-overview-state fp-overview-error"><span>{error}</span><button onClick={() => void loadOverview()}>Try again</button></div> : overview?.recentActivity.length ? <div className="fp-overview-activity-list">
        {overview.recentActivity.map(item => <div className="fp-overview-activity-item" key={item.id}>
          <span className="fp-overview-activity-icon">{item.status === "reversed" ? <ArrowLeftRight size={17}/> : <Activity size={17}/>}</span>
          <span className="fp-overview-activity-copy"><b>{item.description || titleCase(item.type)}</b><small>{titleCase(item.type)} · {dateLabel(item.postedAt || item.createdAt)}</small></span>
          <span className={item.status === "reversed" ? "fp-overview-activity-status reversed" : "fp-overview-activity-status"}>{titleCase(item.status)}</span>
        </div>)}
      </div> : <div className="fp-empty"><FileText size={23}/><b>No posted transactions yet</b><span>When your account has ledger-confirmed activity, the latest transactions will appear here.</span></div>}
      {!loading && !error && <p className="fp-overview-footnote">Only posted or reversed ledger transactions for your own customer accounts are shown. No sample records or estimated amounts are used.</p>}
    </section>
  </>;
}
