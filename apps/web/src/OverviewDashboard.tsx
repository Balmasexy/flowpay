import { useCallback, useEffect, useState } from "react";
import { getApiJwt } from "./auth-client";
import {
  Activity, ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Cable, ChevronRight,
  Clock3, CreditCard, FileText, Phone, RefreshCw, ShieldCheck, Wallet, Wifi, Zap
} from "lucide-react";

type AccountSummary = { currency: string; status: string; count: number };
type ActivityItem = {
  id: string; type: string; description: string; status: "posted" | "reversed";
  createdAt: string; postedAt: string | null;
};
type OnboardingSummary = { flowpayAccountNumber: string; cardStatus: string };
type Overview = {
  accounts: AccountSummary[];
  recentActivity: ActivityItem[];
  transactionSummary: { postedCount: number; reversedCount: number } | null;
  balance: { available: true; balances: { currency: string; amountMinor: string }[] } | { available: false; reason: string };
  generatedAt: string;
};

const services = [
  { label: "Airtime", path: "/airtime", icon: Phone, detail: "Recharge with provider verification" },
  { label: "Data", path: "/data", icon: Wifi, detail: "Choose a provider-priced data bundle" },
  { label: "Transfers", path: "/transfers", icon: ArrowLeftRight, detail: "Send to a FlowPay wallet or Nigerian bank" },
  { label: "Cards", path: "/cards", icon: CreditCard, detail: "Review linked card records" },
  { label: "Electricity", path: "/bills", icon: Zap, detail: "Verify meter and pay through provider" },
  { label: "Cable TV", path: "/cable-tv", icon: Cable, detail: "Provider activation is still required" },
  { label: "Savings", path: "/savings", icon: Wallet, detail: "Review savings tools and goals" },
  { label: "More", path: "/more", icon: ChevronRight, detail: "Explore the rest of FlowPay" },
];

const providers = ["MTN", "Airtel", "Glo", "9mobile"];

type CachedBalance = {
  subject: string;
  balances: { currency: string; amountMinor: string }[];
  generatedAt: string;
};
const BALANCE_CACHE_KEY = "flowpay.last-ledger-balance.v1";

function readTokenSubject(token: string): string | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="))) as Record<string, unknown>;
    return typeof decoded.sub === "string" && decoded.sub.trim() &&
      typeof decoded.exp === "number" && decoded.exp > Date.now() / 1000
      ? decoded.sub : null;
  } catch {
    return null;
  }
}

function readCachedBalance(token: string): CachedBalance | null {
  const subject = readTokenSubject(token);
  if (!subject || typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(BALANCE_CACHE_KEY);
    if (!raw) return null;
    const saved = asRecord(JSON.parse(raw));
    if (!saved || saved.subject !== subject || typeof saved.generatedAt !== "string" ||
        !Number.isFinite(Date.parse(saved.generatedAt)) || !Array.isArray(saved.balances) ||
        saved.balances.length === 0) return null;
    const balances: { currency: string; amountMinor: string }[] = [];
    for (const rawBalance of saved.balances) {
      const item = asRecord(rawBalance);
      if (!item || typeof item.currency !== "string" || !/^[A-Z]{3}$/.test(item.currency) ||
          typeof item.amountMinor !== "string" || !/^-?\d+$/.test(item.amountMinor) ||
          !Number.isSafeInteger(Number(item.amountMinor))) return null;
      balances.push({ currency: item.currency, amountMinor: item.amountMinor });
    }
    return { subject, balances, generatedAt: saved.generatedAt };
  } catch {
    return null;
  }
}

function saveCachedBalance(token: string, overview: Overview): CachedBalance | null {
  const subject = readTokenSubject(token);
  if (!subject || !overview.balance.available || overview.balance.balances.length === 0 ||
      !Number.isFinite(Date.parse(overview.generatedAt)) || typeof window === "undefined") return null;
  const snapshot: CachedBalance = {
    subject,
    balances: overview.balance.balances,
    generatedAt: overview.generatedAt
  };
  try {
    window.sessionStorage.setItem(BALANCE_CACHE_KEY, JSON.stringify(snapshot));
  } catch {
    // Storage is optional; the live response remains available without it.
  }
  return snapshot;
}

function clearCachedBalance(token: string) {
  const subject = readTokenSubject(token);
  if (!subject || typeof window === "undefined") return;
  try {
    const cached = readCachedBalance(token);
    if (cached?.subject === subject) window.sessionStorage.removeItem(BALANCE_CACHE_KEY);
  } catch {
    // Ignore storage access errors.
  }
}


function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseOverview(value: unknown): Overview | null {
  const root = asRecord(value);
  const body = asRecord(root?.overview);
  const balance = asRecord(body?.balance);
  if (!body || !balance || !Array.isArray(body.accounts) || !Array.isArray(body.recentActivity)) return null;
  let parsedTransactionSummary: { postedCount: number; reversedCount: number } | null = null;
  if (body.transactionSummary !== undefined) {
    const transactionSummary = asRecord(body.transactionSummary);
    if (!transactionSummary ||
        !Number.isSafeInteger(transactionSummary.postedCount) || (transactionSummary.postedCount as number) < 0 ||
        !Number.isSafeInteger(transactionSummary.reversedCount) || (transactionSummary.reversedCount as number) < 0) return null;
    parsedTransactionSummary = {
      postedCount: transactionSummary.postedCount as number,
      reversedCount: transactionSummary.reversedCount as number,
    };
  }
  if (typeof body.generatedAt !== "string") return null;
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
      if (!/^-?\d+$/.test(amountMinor) || !Number.isSafeInteger(Number(amountMinor))) return null;
      balances.push({ currency: row.currency, amountMinor });
    }
    return { accounts, recentActivity, transactionSummary: parsedTransactionSummary, balance: { available: true, balances }, generatedAt: body.generatedAt };
  }
  if (balance.available === false && typeof balance.reason === "string") {
    return { accounts, recentActivity, transactionSummary: parsedTransactionSummary, balance: { available: false, reason: balance.reason.slice(0, 200) }, generatedAt: body.generatedAt };
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
  const [overviewSubject, setOverviewSubject] = useState<string | null>(null);
  const [cachedBalance, setCachedBalance] = useState<CachedBalance | null>(() => readCachedBalance(token));
  const [onboarding, setOnboarding] = useState<OnboardingSummary | null>(null);
  const [onboardingSubject, setOnboardingSubject] = useState<string | null>(null);
  const currentSubject = readTokenSubject(token);
  const visibleOverview = overviewSubject === currentSubject ? overview : null;
  const visibleCachedBalance = cachedBalance?.subject === currentSubject ? cachedBalance : null;
  const visibleOnboarding = onboardingSubject === currentSubject ? onboarding : null;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadOverview = useCallback(async () => {
    if (!token || token.split(".").length !== 3 || !readTokenSubject(token)) {
      setOverview(null); setOverviewSubject(null); setOnboarding(null); setOnboardingSubject(null);
      setCachedBalance(null);
      setError("Your secure session is not ready. Refresh after signing in again."); setLoading(false); return;
    }
    // Keep the last verified ledger snapshot visible while refreshing.
    // A transient network/auth failure must not erase a previously confirmed balance.
    setLoading(true); setError("");
    const apiBase = String(import.meta.env.VITE_API_BASE_URL || "").replace(/\/+$/, "");
    if (!apiBase) { setCachedBalance(readCachedBalance(token)); setError("FlowPay API address is not configured."); setLoading(false); return; }
    try {
      const jwt = await getApiJwt();
      const bootstrapResponse = await fetch(apiBase + "/customer/bootstrap", {
        method: "POST", credentials: "omit", headers: { Authorization: "Bearer " + jwt }
      });
      const bootstrapData = await bootstrapResponse.json().catch(() => ({}));
      if (!bootstrapResponse.ok || bootstrapData?.provisioned !== true ||
          typeof bootstrapData?.flowpayAccountNumber !== "string" ||
          !/^[1-9][0-9]{9}$/.test(bootstrapData.flowpayAccountNumber)) {
        if (bootstrapResponse.status === 401 || bootstrapResponse.status === 403) {
          clearCachedBalance(token);
          setCachedBalance(null);
        }
        throw new Error(bootstrapData?.message || bootstrapData?.error || "Your FlowPay account is still being set up.");
      }
      setOnboarding({
        flowpayAccountNumber: bootstrapData.flowpayAccountNumber,
        cardStatus: typeof bootstrapData?.virtualCard?.status === "string" ? bootstrapData.virtualCard.status : "pending"
      });
      setOnboardingSubject(currentSubject);
      const response = await fetch(apiBase + "/customer/overview", {
        method: "GET", credentials: "omit", headers: { Authorization: "Bearer " + jwt }
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          clearCachedBalance(token);
          setCachedBalance(null);
        }
        throw new Error(response.status === 401 ? "Your session has expired. Please sign in again." : data.error || "Unable to load your account overview.");
      }
      const parsed = parseOverview(data);
      if (!parsed) throw new Error("The account overview service returned an invalid response.");
      setOverview(parsed);
      setOverviewSubject(currentSubject);
      const cached = saveCachedBalance(token, parsed);
      if (cached) setCachedBalance(cached);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to refresh your account overview.");
    } finally { setLoading(false); }
  }, [token]);

  useEffect(() => { setCachedBalance(readCachedBalance(token)); }, [token]);
  useEffect(() => { void loadOverview(); }, [loadOverview]);

  const postedCount = visibleOverview?.transactionSummary?.postedCount ?? 0;
  const reversedCount = visibleOverview?.transactionSummary?.reversedCount ?? 0;
  const transactionCount = postedCount + reversedCount;
  const freshBalances = visibleOverview?.balance.available && visibleOverview.balance.balances.length > 0
    ? visibleOverview.balance.balances : null;
  const displayedBalances = freshBalances ?? visibleCachedBalance?.balances ?? null;
  const isCachedBalance = !freshBalances && Boolean(visibleCachedBalance);

  return <>
    <section className="fp-balance">
      <div className="fp-balance-top"><span>Wallet balance</span><div className="fp-balance-top-actions"><button type="button" className="fp-balance-history" onClick={() => go("/activity")}><Activity size={15}/> Transaction history <ChevronRight size={14}/></button><button type="button" className="fp-balance-refresh" style={{background:"transparent",border:0,color:"inherit",padding:6,cursor:loading?"wait":"pointer",display:"inline-flex",alignItems:"center"}} onClick={() => void loadOverview()} disabled={loading} aria-label="Refresh dashboard balance and activity" title="Refresh dashboard"><RefreshCw size={17}/></button></div></div>
      {displayedBalances ? <div className="fp-balance-values" role="status" aria-live="polite">{displayedBalances.map(item => <strong key={item.currency}>{formatBalance(item.currency, item.amountMinor)}</strong>)}</div> : loading ? <strong className="fp-balance-unavailable" role="status" aria-live="polite">Verifying ledger balance…</strong> : <strong className="fp-balance-unavailable" role="status" aria-live="polite">Balance not yet verified</strong>}
      <small>{freshBalances
        ? (isVerifiedZeroBalance(freshBalances) ? "Verified zero balance from your current posted ledger entries." : "Current balance returned by the authenticated FlowPay ledger.")
        : isCachedBalance && visibleCachedBalance
          ? "Last loaded ledger balance from " + dateLabel(visibleCachedBalance.generatedAt) + ". This snapshot is for display only and is not live; every transfer checks the current server ledger."
          : error ? "We could not verify a balance yet. No estimated or sample amount is displayed." : "Balance appears after the authenticated ledger service verifies your account."}</small>
      <div className="fp-balance-actions" aria-label="Quick money actions">
        <button onClick={() => go("/transfers?mode=flowpay")}><ArrowDownLeft size={17}/> To FlowPay</button>
        <button onClick={() => go("/transfers?mode=bank")}><ArrowUpRight size={17}/> To Bank</button>
        <button onClick={() => go("/money-received")}><ArrowDownLeft size={17}/> Add Money</button>
        <button onClick={() => go("/savings")}><Wallet size={17}/> Save</button>
      </div>
      {(visibleOverview?.generatedAt || visibleCachedBalance?.generatedAt) && <small className="fp-overview-updated">{isCachedBalance && visibleCachedBalance ? "Last loaded " + dateLabel(visibleCachedBalance.generatedAt) : "Last updated " + dateLabel(visibleOverview!.generatedAt)}</small>}
    </section>

    <section className="fp-overview-grid" aria-label="Your FlowPay account">
      <article className="fp-overview-card">
        <div className="fp-overview-card-heading"><span className="fp-overview-icon"><Wallet size={19}/></span><span>Your FlowPay account number</span></div>
        <strong className="fp-overview-service-status" style={{fontVariantNumeric:"tabular-nums",letterSpacing:".08em"}}>{visibleOnboarding?.flowpayAccountNumber ?? (loading ? "Assigning…" : "Not available")}</strong>
        <p className="fp-overview-muted">Your unique 10-digit number for receiving transfers from other FlowPay customers.</p>
        <button className="fp-overview-link" onClick={() => go("/account-number")}>Account details <ChevronRight size={15}/></button>
      </article>
      <article className="fp-overview-card">
        <div className="fp-overview-card-heading"><span className="fp-overview-icon"><CreditCard size={19}/></span><span>Your virtual card</span></div>
        <strong className="fp-overview-service-status">{visibleOnboarding?.cardStatus === "pending" ? "Awaiting issuer" : visibleOnboarding?.cardStatus ? titleCase(visibleOnboarding.cardStatus) : loading ? "Preparing…" : "Not linked"}</strong>
        <p className="fp-overview-muted">A card preview appears now. A working card number, CVV and expiry are shown only after an approved issuer creates the card.</p>
        <button className="fp-overview-link" onClick={() => go("/cards")}>Open virtual card <ChevronRight size={15}/></button>
      </article>
    </section>

    <section className="fp-overview-grid" aria-label="Account overview">
      <article className="fp-overview-card fp-transaction-summary-card">
        <div className="fp-overview-card-heading"><span className="fp-overview-icon"><Activity size={19}/></span><span>Ledger activity summary</span></div>
        {loading ? <p className="fp-overview-muted">Loading posted and reversed transaction totals…</p> : error ? <p className="fp-overview-muted">Transaction totals are temporarily unavailable.</p> : visibleOverview?.transactionSummary ? <>
          <div className="fp-overview-stat-row">
            <div><strong>{postedCount.toLocaleString("en-NG")}</strong><span>Posted transactions</span></div>
            <div><strong>{reversedCount.toLocaleString("en-NG")}</strong><span>Reversed transactions</span></div>
          </div>
          <div className="fp-overview-currencies"><span>Total recorded ledger transactions</span><b>{transactionCount.toLocaleString("en-NG")}</b></div>
        </> : <p className="fp-overview-muted">Transaction totals are not available from the current API version. Refresh to try again.</p>}
        <button className="fp-overview-link" onClick={() => go("/activity")}>Open transaction history <ChevronRight size={15}/></button>
      </article>
      <article className="fp-overview-card fp-account-safety-card">
        <div className="fp-overview-card-heading"><span className="fp-overview-icon"><ShieldCheck size={19}/></span><span>Account services</span></div>
        <strong className="fp-overview-service-status">Transfer and bill services</strong>
        <p className="fp-overview-muted">FlowPay wallet transfers use recipient, PIN and ledger checks. Nigerian bank payouts require Paystack transfer approval and an enabled environment. Airtime, data and electricity use VTpass provider confirmation.</p>
        <button className="fp-overview-link" onClick={() => go("/transfers")}>Open transfers <ChevronRight size={15}/></button>
      </article>
    </section>

    <section className="fp-section fp-home-services">
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
      {loading ? <div className="fp-overview-state"><Clock3 size={22}/><span>Loading verified activity…</span></div> : error ? <div className="fp-overview-state fp-overview-error"><span>{error}</span><button onClick={() => void loadOverview()}>Try again</button></div> : visibleOverview?.recentActivity.length ? <div className="fp-overview-activity-list">
        {visibleOverview.recentActivity.map(item => <div className="fp-overview-activity-item" key={item.id}>
          <span className="fp-overview-activity-icon">{item.status === "reversed" ? <ArrowLeftRight size={17}/> : <Activity size={17}/>}</span>
          <span className="fp-overview-activity-copy"><b>{item.description || titleCase(item.type)}</b><small>{titleCase(item.type)} · {dateLabel(item.postedAt || item.createdAt)}</small></span>
          <span className={item.status === "reversed" ? "fp-overview-activity-status reversed" : "fp-overview-activity-status"}>{titleCase(item.status)}</span>
        </div>)}
      </div> : <div className="fp-empty"><FileText size={23}/><b>No posted transactions yet</b><span>When your account has ledger-confirmed activity, the latest transactions will appear here.</span></div>}
      {!loading && !error && <p className="fp-overview-footnote">Only posted or reversed ledger transactions for your own customer accounts are shown. No sample records or estimated amounts are used.</p>}
    </section>
  </>;
}
