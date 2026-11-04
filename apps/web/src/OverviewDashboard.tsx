import { useCallback, useEffect, useState } from "react";
import {
  Activity, ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Cable, ChevronRight,
  Clock3, CreditCard, FileText, Phone, RefreshCw, ShieldCheck, Wallet, Wifi, Zap
} from "lucide-react";

type AccountSummary = { currency: string; status: string; count: number };
type ActivityItem = {
  id: string; type: string; description: string; status: "posted" | "reversed";
  createdAt: string; postedAt: string | null;
};
type Overview = {
  accounts: AccountSummary[];
  recentActivity: ActivityItem[];
  transactionSummary: { postedCount: number; reversedCount: number };
  balance: { available: true; balances: { currency: string; amountMinor: string }[] } | { available: false; reason: string };
  paymentsEnabled: false;
  generatedAt: string;
};

const services = [
  { label: "Airtime", path: "/airtime", icon: Phone, detail: "Review airtime options (preview only)" },
  { label: "Data", path: "/data", icon: Wifi, detail: "Review available bundles (preview only)" },
  { label: "Transfers", path: "/transfers", icon: ArrowLeftRight, detail: "Prepare a transfer preview" },
  { label: "Cards", path: "/cards", icon: CreditCard, detail: "Review linked card records" },
  { label: "Electricity", path: "/bills", icon: Zap, detail: "Review bill-payment options (preview only)" },
  { label: "Cable TV", path: "/cable-tv", icon: Cable, detail: "Review TV subscription options (preview only)" },
  { label: "Savings", path: "/savings", icon: Wallet, detail: "Review savings tools and goals" },
  { label: "History", path: "/activity", icon: Clock3, detail: "Review posted and reversed ledger activity" },
];

const providers = ["MTN", "Airtel", "Glo", "9mobile"];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseOverview(value: unknown): Overview | null {
  const root = asRecord(value);
  const body = asRecord(root?.overview);
  const balance = asRecord(body?.balance);
  const transactionSummary = asRecord(body?.transactionSummary);
  if (!body || !balance || !transactionSummary || !Array.isArray(body.accounts) || !Array.isArray(body.recentActivity)) return null;
  if (!Number.isSafeInteger(transactionSummary.postedCount) || (transactionSummary.postedCount as number) < 0 ||
      !Number.isSafeInteger(transactionSummary.reversedCount) || (transactionSummary.reversedCount as number) < 0) return null;
  if (body.paymentsEnabled !== false || typeof body.generatedAt !== "string") return null;
  const accounts: AccountSummary[] = [];
  for (const raw of body.accounts) {
    const row = asRecord(raw);
    if (!row || typeof row.currency !== "string" || !/^[A-Z]{3}$/.test(row.currency) || typeof row.status !== "string" || !Number.isSafeInteger(row.count) || (row.count as number) < 0) return null;
    accounts.push({ currency: row.currency, status: row.status.slice(0, 30), count: row.count as number });
  }
  const recentActivity: ActivityItem[] = [];
  for (const raw of body.recentActivity) {
    const row = asRecord(raw);
    if (!row || typeof row.id !== "string" || !row.id.trim() || typeof row.type !== "string" || typeof row.status !== "string" || !["posted", "reversed"].includes(row.status) || typeof row.createdAt !== "string") return null;
    recentActivity.push({
      id: row.id.slice(0, 128), type: row.type.slice(0, 60),
      description: typeof row.description === "string" ? row.description.slice(0, 160) : "",
      status: row.status as ActivityItem["status"], createdAt: row.createdAt,
      postedAt: typeof row.postedAt === "string" ? row.postedAt : null,
    });
  }
  if (balance.available === true) {
    if (!Array.isArray(balance.balances)) return null;
    const balances: { currency: string; amountMinor: string }[] = [];
    for (const raw of balance.balances) {
      const row = asRecord(raw);
      if (!row || typeof row.currency !== "string" || !/^[A-Z]{3}$/.test(row.currency) || (typeof row.amountMinor !== "string" && typeof row.amountMinor !== "number")) return null;
      const amountMinor = String(row.amountMinor);
      if (!/^-?\\d+$/.test(amountMinor) || !Number.isSafeInteger(Number(amountMinor))) return null;
      balances.push({ currency: row.currency, amountMinor });
    }
    return { accounts, recentActivity, transactionSummary: { postedCount: transactionSummary.postedCount as number, reversedCount: transactionSummary.reversedCount as number }, balance: { available: true, balances }, paymentsEnabled: false, generatedAt: body.generatedAt };
  }
  if (balance.available === false && typeof balance.reason === "string") {
    return { accounts, recentActivity, transactionSummary: { postedCount: transactionSummary.postedCount as number, reversedCount: transactionSummary.reversedCount as number }, balance: { available: false, reason: balance.reason.slice(0, 200) }, paymentsEnabled: false, generatedAt: body.generatedAt };
  }
  return null;
}

function formatBalance(currency: string, amountMinor: string): string {
  const amount = Number(amountMinor) / 100;
  try { return new Intl.NumberFormat("en-NG", { style: "currency", currency }).format(amount); }
  catch { return currency + " " + amount.toFixed(2); }
}

function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleString();
}

function titleCase(value: string) {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, letter => letter.toUpperCase());
}

function isVerifiedZeroBalance(balances: { currency: string; amountMinor: string }[]) {
  return balances.length > 0 && balances.every(item => item.amountMinor === "0");
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
      const parsed = parseOverview(data);
      if (!parsed) throw new Error("The account overview service returned an invalid response.");
      setOverview(parsed);
    } catch (cause) {
      setOverview(null);
      setError(cause instanceof Error ? cause.message : "Unable to load your account overview.");
    } finally { setLoading(false); }
  }, [token]);

  useEffect(() => { void loadOverview(); }, [loadOverview]);

  const accountCount = overview?.accounts.reduce((total, account) => total + account.count, 0) ?? 0;
  const activeAccountCount = overview?.accounts.filter(account => account.status === "active").reduce((total, account) => total + account.count, 0) ?? 0;
  const currencies = [...new Set(overview?.accounts.filter(account => account.status === "active").map(account => account.currency) ?? [])];
  const postedCount = overview?.transactionSummary.postedCount ?? 0;
  const reversedCount = overview?.transactionSummary.reversedCount ?? 0;
  const transactionCount = postedCount + reversedCount;

  return <>
    <section className="fp-balance">
      <div className="fp-balance-top"><span>Available balance</span><button type="button" className="fp-balance-refresh" style={{background:"transparent",border:0,color:"inherit",padding:6,cursor:loading?"wait":"pointer",display:"inline-flex",alignItems:"center"}} onClick={() => void loadOverview()} disabled={loading} aria-label="Refresh dashboard balance and activity" title="Refresh dashboard"><RefreshCw size={17}/></button></div>
      {loading ? <strong className="fp-balance-unavailable" role="status" aria-live="polite">Loading…</strong> : error ? <strong className="fp-balance-unavailable" role="status" aria-live="polite">Temporarily unavailable</strong> : overview?.balance.available && overview.balance.balances.length > 0 ? <div className="fp-balance-values" role="status" aria-live="polite">{overview.balance.balances.map(item => <strong key={item.currency}>{formatBalance(item.currency, item.amountMinor)}</strong>)}</div> : <strong className="fp-balance-unavailable" role="status" aria-live="polite">Not available</strong>}
      <small>{error ? "We could not refresh your verified account data. No estimated or sample amount is displayed." : overview?.balance.available && overview.balance.balances.length > 0 ? isVerifiedZeroBalance(overview.balance.balances) ? "Verified zero balance: no posted ledger entries are recorded for these active customer accounts." : "Balance values are returned by the authenticated FlowPay ledger service." : !loading && overview?.balance.available ? "No active customer account is available for balance calculation." : "Balance is unavailable until the ledger sign convention is confirmed. No estimated or sample amount is shown."}</small>
      <div className="fp-balance-actions">
        <button onClick={() => go("/money-received")}><ArrowDownLeft size={17}/> Money received</button>
        <button onClick={() => go("/money-sent")}><ArrowUpRight size={17}/> Money sent</button>
      </div>
      {!loading && !error && overview?.generatedAt && <small className="fp-overview-updated">Last updated {dateLabel(overview.generatedAt)}</small>}
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
      <article className="fp-overview-card fp-transaction-summary-card">
        <div className="fp-overview-card-heading"><span className="fp-overview-icon"><Activity size={19}/></span><span>Ledger activity summary</span></div>
        {loading ? <p className="fp-overview-muted">Loading posted and reversed transaction totals…</p> : error ? <p className="fp-overview-muted">Transaction totals are temporarily unavailable.</p> : <>
          <div className="fp-overview-stat-row">
            <div><strong>{postedCount.toLocaleString("en-NG")}</strong><span>Posted transactions</span></div>
            <div><strong>{reversedCount.toLocaleString("en-NG")}</strong><span>Reversed transactions</span></div>
          </div>
          <div className="fp-overview-currencies"><span>Total recorded ledger transactions</span><b>{transactionCount.toLocaleString("en-NG")}</b></div>
        </>}
        <button className="fp-overview-link" onClick={() => go("/activity")}>Open transaction history <ChevronRight size={15}/></button>
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
