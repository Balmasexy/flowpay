import { useEffect, useState } from "react";
import PasskeySecurity from "./PasskeySecurity";
import BulkOperations from "./BulkOperations";
import {
  ArrowDownLeft, ArrowLeftRight, ArrowRight, ArrowUpRight, Bell,
  CheckCircle2, Clock3, CreditCard, Home,
  Menu, RefreshCw, ShieldCheck, Wallet, X, UserRound, LockKeyhole,
  Eye, Building2, Mail, Banknote, LogOut
} from "lucide-react";

const API_URL = (import.meta.env.VITE_API_BASE_URL || "https://flowpay-backend-qz79.onrender.com").replace(/\/$/, "");
const AUTH_URL = (import.meta.env.VITE_NEON_AUTH_URL || "").replace(/\/$/, "");

type ApiStatus = "checking" | "connected" | "unavailable";
type DatabaseStatus = "checking" | "connected" | "unavailable" | "not_configured" | "schema_incomplete";
type Page = "Overview" | "Transfers" | "Cards" | "Activity" | "Money Received" | "Money Sent" | "Customer Profile" | "View Account Number" | "Security" | "Bulk Payments" | "Bulk Verification";
type ActivityFilter = "all" | "received" | "sent" | "transfers" | "cards";
type CustomerProfile = { id: string; email: string | null; status: string; created_at: string };
type Account = { id: string; currency: string; status: string; ledger_balance_minor: string };
type SummaryTotal = { currency: string; net_balance_minor: string; money_received_minor: string; money_sent_minor: string };
type Transaction = { id: string; transaction_type: string; status: string; description: string | null; created_at: string; currency: string; amount_minor: string };
type CustomerCard = { id: string; card_type: "virtual" | "physical"; status: string; last4: string | null; expiry_month: number | null; expiry_year: number | null; created_at: string; updated_at: string };
type CardEvent = { id: string; card_id: string; event_type: string; outcome: string; created_at: string };

async function getAccessToken(): Promise<string | null> {
  if (!AUTH_URL) return null;
  try {
    // Managed Neon Auth issues the API JWT on GET /get-session in this header.
    // The browser session itself remains in the HttpOnly cookie.
    const response = await fetch(`${AUTH_URL}/get-session`, {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) return null;
    const token = response.headers.get("set-auth-jwt")?.trim();
    return token && token.split(".").length === 3 ? token : null;
  } catch {
    return null;
  }
}

function formatMinor(value: string, currency: string): string {
  try {
    const digits = new Intl.NumberFormat(undefined, { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
    const amount = Number(value) / (10 ** digits);
    if (!Number.isFinite(amount)) return "Unavailable";
    return new Intl.NumberFormat(undefined, { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(amount);
  } catch {
    return `${currency} ${value}`;
  }
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleString();
}


function LandingPage() {
  return (
    <div className="landing-shell">
      <header className="landing-nav">
        <a className="landing-brand" href="/" aria-label="FlowPay home"><span className="landing-brand-mark">F</span><span>flow<span>pay</span></span></a>
        <nav className="landing-links" aria-label="Main navigation">
          <a href="#features">Features</a><a href="#security">Security</a><a href="#about">About</a>
        </nav>
        <div className="landing-nav-actions"><a className="landing-signin" href="/login">Sign in</a><a className="landing-cta" href="/signup">Create account <ArrowRight size={16} /></a></div>
      </header>

      <main>
        <section className="landing-hero">
          <div className="landing-hero-copy">
            <div className="landing-kicker"><span /> A clearer way to manage your money</div>
            <h1>Your money.<br /><em>More freedom.</em></h1>
            <p className="landing-lede">A simpler place to see your financial picture. FlowPay brings account information and activity into one clear, easy-to-use workspace.</p>
            <div className="landing-hero-actions"><a className="landing-cta landing-cta-large" href="/login">Explore FlowPay <ArrowRight size={18} /></a><a className="landing-secondary-link" href="#features">Discover the platform <ArrowDownLeft size={17} /></a></div>
            <div className="landing-trust-line"><ShieldCheck size={17} /><span>Built around clarity, privacy, and responsible access</span></div>
          </div>
          <div className="landing-visual" aria-label="Illustration of a financial overview dashboard">
            <div className="landing-orbit landing-orbit-one" /><div className="landing-orbit landing-orbit-two" />
            <div className="landing-preview-card">
              <div className="landing-preview-top"><span className="landing-preview-logo"><span>F</span> flowpay</span><span className="landing-live-label"><i /> Financial overview</span></div>
              <div className="landing-preview-label">YOUR FINANCIAL OVERVIEW</div>
              <div className="landing-preview-title">Everything in view.</div>
              <div className="landing-preview-balance"><span>Account summary</span><strong>Verified data only</strong><small>Figures appear when securely available.</small></div>
              <div className="landing-preview-row"><span className="landing-preview-icon"><ArrowDownLeft size={18} /></span><span><b>Money received</b><small>Ledger-backed activity</small></span><span className="landing-preview-status">View</span></div>
              <div className="landing-preview-row"><span className="landing-preview-icon"><CreditCard size={18} /></span><span><b>Cards</b><small>Secure card metadata</small></span><span className="landing-preview-status">View</span></div>
              <div className="landing-preview-row"><span className="landing-preview-icon"><Clock3 size={18} /></span><span><b>Activity</b><small>History in one place</small></span><span className="landing-preview-status">View</span></div>
              <div className="landing-preview-foot"><ShieldCheck size={15} /><span>No demo balances or invented transactions</span></div>
            </div>
            <div className="landing-float-chip"><span><ShieldCheck size={18} /></span><div><b>Security-minded</b><small>Privacy comes first</small></div></div>
          </div>
        </section>

        <section className="landing-proof-strip" id="about"><div><b>Clear by design</b><span>Less clutter. More understanding.</span></div><div><b>Data with integrity</b><span>Financial figures are never guessed.</span></div><div><b>Built to grow</b><span>A considered foundation for what comes next.</span></div></section>

        <section className="landing-features" id="features">
          <div className="landing-section-intro"><span className="landing-section-kicker">THE FLOWPAY EXPERIENCE</span><h2>More clarity at every step.</h2><p>Thoughtful tools that help you understand your financial activity without unnecessary complexity.</p></div>
          <div className="landing-feature-grid">
            <article className="landing-feature"><span className="landing-feature-icon"><Wallet size={22} /></span><h3>Your financial overview</h3><p>See account information and available summaries in one organized workspace, when verified data is available.</p><a href="/login">Explore overview <ArrowRight size={15} /></a></article>
            <article className="landing-feature"><span className="landing-feature-icon"><ArrowLeftRight size={22} /></span><h3>Activity, made clearer</h3><p>Review financial history in a straightforward layout designed to distinguish real records from unavailable data.</p><a href="/login">Explore activity <ArrowRight size={15} /></a></article>
            <article className="landing-feature" id="security"><span className="landing-feature-icon"><ShieldCheck size={22} /></span><h3>Security-minded by default</h3><p>Customer information belongs behind authentication. Sensitive credentials and unverified balances stay out of view.</p><a href="/login">Enter workspace <ArrowRight size={15} /></a></article>
          </div>
        </section>

        <section className="landing-bottom-cta"><div><span className="landing-section-kicker">A BETTER VIEW STARTS HERE</span><h2>Bring your financial picture into focus.</h2><p>Open the FlowPay workspace to explore the current experience and its available features.</p></div><a className="landing-cta landing-cta-large" href="/login">Open FlowPay <ArrowRight size={18} /></a></section>
      </main>
      <footer className="landing-footer"><a className="landing-brand" href="/"><span className="landing-brand-mark">F</span><span>flow<span>pay</span></span></a><span>© {new Date().getFullYear()} FlowPay</span><span>Your financial workspace</span></footer>
    </div>
  );
}


function AuthPage({ mode }: { mode: "login" | "signup" }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const isSignup = mode === "signup";

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    setError("");
    if (!AUTH_URL) {
      setError("Account access is not configured yet. Please contact FlowPay support.");
      setBusy(false);
      return;
    }
    try {
      const endpoint = isSignup ? "sign-up/email" : "sign-in/email";
      const payload = isSignup ? { name: name.trim(), email: email.trim(), password } : { email: email.trim(), password };
      const response = await fetch(`${AUTH_URL}/${endpoint}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000)
      });
      const result: unknown = await response.json().catch(() => ({}));
      const record = typeof result === "object" && result !== null ? result as Record<string, unknown> : {};
      if (!response.ok || record.error) {
        const detail = typeof record.message === "string" ? record.message
          : typeof record.error === "string" ? record.error : `Request failed (HTTP ${response.status})`;
        throw new Error(detail);
      }
      if (isSignup) {
        const token = await getAccessToken();
        if (token) {
          const bootstrap = await fetch(`${API_URL}/v1/me/bootstrap`, {
            method: "POST",
            headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(10000)
          });
          if (!bootstrap.ok) {
            setMessage("Sign-up was accepted. Your FlowPay profile will be created after you verify your email and sign in. A bank account number appears only after an approved provider assigns it.");
          } else {
            setMessage("Your FlowPay profile and internal NGN account are ready. A real bank account number will appear after an approved provider assigns it; no placeholder number is used.");
          }
        } else {
          setMessage("Registration request submitted. If email verification is enabled, verify your address and sign in. FlowPay will create your profile and internal NGN account automatically; a real bank account number requires an approved provider assignment.");
        }
        setPassword("");
      } else {
        const token = await getAccessToken();
        if (!token) {
          setMessage("Sign-in was accepted, but a session token could not be confirmed. Check the auth service configuration and try again.");
        } else {
          window.location.assign("/app");
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to complete the request. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <a className="auth-back-link" href="/">← Back to FlowPay</a>
      <section className="auth-layout">
        <div className="auth-story">
          <a className="landing-brand" href="/"><span className="landing-brand-mark">F</span><span>flow<span>pay</span></span></a>
          <span className="landing-section-kicker">A clearer financial workspace</span>
          <h1>{isSignup ? "Make room for more clarity." : "Welcome back to FlowPay."}</h1>
          <p>{isSignup ? "Create your sign-in credentials to get started. Financial accounts and balances are shown only when securely configured and verified." : "Sign in securely to continue to your FlowPay workspace and view data available to your authenticated account."}</p>
          <div className="auth-assurance"><ShieldCheck size={20} /><span>Your password is sent only to the configured authentication service.</span></div>
        </div>
        <div className="auth-card">
          <div className="auth-card-heading">
            <span className="auth-card-icon">{isSignup ? <UserRound size={21} /> : <LockKeyhole size={21} />}</span>
            <h2>{isSignup ? "Create your account" : "Sign in"}</h2>
            <p>{isSignup ? "Use an email address you can access." : "Enter your account details below."}</p>
          </div>
          <form className="auth-form" onSubmit={submit}>
            {isSignup && <label>Full name<input autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Your full name" required minLength={2} maxLength={100} /></label>}
            <label>Email address<span className="auth-input-wrap"><Mail size={17} /><input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" required maxLength={254} /></span></label>
            <label>Password<span className="auth-input-wrap"><LockKeyhole size={17} /><input type="password" autoComplete={isSignup ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={isSignup ? "At least 8 characters" : "Your password"} required minLength={isSignup ? 8 : 1} maxLength={128} /></span></label>
            {error && <p className="auth-feedback auth-error" role="alert">{error}</p>}
            {message && <p className="auth-feedback auth-message" role="status">{message}</p>}
            <button className="auth-submit" type="submit" disabled={busy}>{busy ? "Please wait…" : isSignup ? "Create account" : "Sign in"} <ArrowRight size={17} /></button>
          </form>
          <p className="auth-switch">{isSignup ? "Already registered?" : "New to FlowPay?"} <a href={isSignup ? "/login" : "/signup"}>{isSignup ? "Sign in" : "Create an account"}</a></p>
          <p className="auth-legal">By continuing, you agree to use FlowPay responsibly. Do not share your password or authentication codes.</p>
        </div>
      </section>
      <footer className="auth-footer">© {new Date().getFullYear()} FlowPay</footer>
    </main>
  );
}

function LogoutPage() {
  const [status, setStatus] = useState("Signing out securely…");
  const [failed, setFailed] = useState(false);

  async function signOut() {
    setFailed(false);
    setStatus("Signing out securely…");
    if (!AUTH_URL) {
      setFailed(true);
      setStatus("Sign-out could not reach the authentication service. Please try again.");
      return;
    }
    try {
      const response = await fetch(`${AUTH_URL}/sign-out`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(10000)
      });
      if (!response.ok) {
        const detail: unknown = await response.json().catch(() => ({}));
        const record = typeof detail === "object" && detail !== null ? detail as Record<string, unknown> : {};
        const message = typeof record.message === "string" ? record.message
          : typeof record.error === "string" ? record.error : `Sign-out failed (HTTP ${response.status})`;
        throw new Error(message);
      }
      window.sessionStorage.removeItem("flowpay.currentPage");
      window.location.replace("/login");
    } catch (error) {
      setFailed(true);
      setStatus(error instanceof Error ? error.message : "Unable to sign out. Please try again.");
    }
  }

  useEffect(() => { void signOut(); }, []);

  return (
    <main className="auth-shell">
      <section className="auth-card logout-card">
        <span className="auth-card-icon"><LogOut size={21} /></span>
        <h2>{failed ? "Sign-out needs attention" : "Signing out"}</h2>
        <p role="status">{status}</p>
        {failed && <button className="auth-submit" type="button" onClick={() => { void signOut(); }}>Try again <LogOut size={17} /></button>}
        {failed && <a className="auth-switch" href="/login">Return to sign in</a>}
      </section>
    </main>
  );
}

export default function App() {
  const [apiStatus, setApiStatus] = useState<ApiStatus>("checking");
  const [apiMessage, setApiMessage] = useState("Checking API connection…");
  const [databaseStatus, setDatabaseStatus] = useState<DatabaseStatus>("checking");
  const [databaseName, setDatabaseName] = useState<string | null>(null);
  const [page, setPage] = useState<Page>(() => {
    const savedPage = window.sessionStorage.getItem("flowpay.currentPage");
    return savedPage === "Transfers" || savedPage === "Cards" || savedPage === "Activity" ||
      savedPage === "Money Received" || savedPage === "Money Sent" || savedPage === "Customer Profile" ||
      savedPage === "View Account Number" || savedPage === "Security" || savedPage === "Bulk Payments" || savedPage === "Bulk Verification"
      ? savedPage
      : "Overview";
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>("all");
  const [customerMessage, setCustomerMessage] = useState("Sign-in session has not been checked yet.");
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [summaryTotals, setSummaryTotals] = useState<SummaryTotal[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [cards, setCards] = useState<CustomerCard[]>([]);
  const [cardEvents, setCardEvents] = useState<CardEvent[]>([]);
  const [customerLoading, setCustomerLoading] = useState(false);

  async function checkApi() {
    if (!API_URL) {
      setApiStatus("unavailable");
      setApiMessage("API URL not configured");
      setDatabaseStatus("not_configured");
      setDatabaseName(null);
      return;
    }

    setApiStatus("checking");
    setApiMessage("Checking API connection…");

    try {
      const response = await fetch(`${API_URL}/health`, {
        headers: { Accept: "application/json" }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data: { status?: string } = await response.json();
      if (data.status !== "ok") throw new Error("Unexpected API response");

      setApiStatus("connected");
      setApiMessage("API connected");
    } catch {
      setApiStatus("unavailable");
      setApiMessage("API unavailable — check deployment and CORS");
      setDatabaseStatus("unavailable");
      setDatabaseName(null);
      return;
    }

    try {
      const response = await fetch(`${API_URL}/ready`, {
        headers: { Accept: "application/json" }
      });
      const readiness: { status?: string; database?: string; database_name?: string; schema?: string } = await response.json();
      if (response.ok && readiness.status === "ready" && readiness.database === "connected" && readiness.schema === "complete") {
        setDatabaseStatus("connected");
        setDatabaseName(readiness.database_name ?? null);
      } else if (readiness.database === "not_configured") {
        setDatabaseStatus("not_configured");
        setDatabaseName(null);
      } else if (readiness.database === "connected" && readiness.schema !== "complete") {
        setDatabaseStatus("schema_incomplete");
        setDatabaseName(readiness.database_name ?? null);
      } else {
        setDatabaseStatus("unavailable");
        setDatabaseName(null);
      }
    } catch {
      setDatabaseStatus("unavailable");
      setDatabaseName(null);
    }
  }

  async function apiGet<T>(path: string): Promise<T> {
    const token = await getAccessToken();
    if (!token) {
      setCustomerMessage(AUTH_URL
        ? "No valid signed-in session was found. Sign in through the configured Neon Auth service."
        : "Neon Auth is not configured. Set VITE_NEON_AUTH_URL to connect customer data.");
      throw new Error("AUTHENTICATION_REQUIRED");
    }
    const response = await fetch(`${API_URL}${path}`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10000)
    });
    const body: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error) : `HTTP ${response.status}`;
      throw new Error(message);
    }
    return body as T;
  }

  async function apiPost<T>(path: string): Promise<T> {
    const token = await getAccessToken();
    if (!token) {
      setCustomerMessage(AUTH_URL
        ? "No valid signed-in session was found. Sign in through the configured Neon Auth service."
        : "Neon Auth is not configured. Set VITE_NEON_AUTH_URL to connect customer data.");
      throw new Error("AUTHENTICATION_REQUIRED");
    }
    const response = await fetch(`${API_URL}${path}`, {
      method: "POST",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10000)
    });
    const body: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error) : `HTTP ${response.status}`;
      throw new Error(message);
    }
    return body as T;
  }

  async function loadCustomerData(target: Page) {
    if (target === "Transfers") return;
    setCustomerLoading(true);
    try {
      // Customer pages are read-only. Profile/account provisioning belongs to the explicit
      // sign-up/bootstrap flow, never as a side effect of opening or refreshing a page.
      if (target === "Overview") {
        // Idempotently provision the signed-in customer's FlowPay profile and internal NGN
        // account before loading read-only account data. This never creates a bank account
        // number, posts a ledger entry, or initiates a payment.
        await apiPost<{ status: string }>("/v1/me/bootstrap");
        const [summary, history] = await Promise.all([
          apiGet<{ totals: SummaryTotal[] }>("/v1/me/summary"),
          apiGet<{ transactions: Transaction[] }>("/v1/me/transactions?limit=5")
        ]);
        setSummaryTotals(summary.totals);
        setTransactions(history.transactions);
        setCustomerMessage("Customer financial summary loaded from posted ledger entries.");
      } else if (target === "Money Received" || target === "Money Sent" || target === "Activity") {
        const filter = target === "Money Received" ? "received"
          : target === "Money Sent" ? "sent" : activityFilter;
        if (target !== "Activity") {
          const summary = await apiGet<{ totals: SummaryTotal[] }>("/v1/me/summary");
          setSummaryTotals(summary.totals);
        }
        if (filter === "cards") {
          const result = await apiGet<{ events: CardEvent[] }>("/v1/me/card-events?limit=100");
          setCardEvents(result.events);
          setTransactions([]);
          setCustomerMessage("Card audit history loaded from the authenticated customer API.");
        } else {
          const result = await apiGet<{ transactions: Transaction[] }>(`/v1/me/transactions?type=${filter}&limit=100`);
          setTransactions(result.transactions);
          setCustomerMessage("Transaction history loaded from the authenticated ledger API.");
        }
      } else if (target === "Cards") {
        const [cardResult, eventResult] = await Promise.all([
          apiGet<{ cards: CustomerCard[] }>("/v1/me/cards"),
          apiGet<{ events: CardEvent[] }>("/v1/me/card-events?limit=50")
        ]);
        setCards(cardResult.cards);
        setCardEvents(eventResult.events);
        setCustomerMessage("Card metadata and audit history loaded. Sensitive card credentials are never returned.");
      } else if (target === "Customer Profile" || target === "View Account Number") {
        // A customer may open Profile or Account Number before visiting Overview.
        // Ensure the authenticated identity has its own FlowPay profile/account first.
        // This is idempotent and does not create a bank account number or move funds.
        await apiPost<{ status: string }>("/v1/me/bootstrap");
        const [profileResult, accountResult, cardResult] = await Promise.all([
          apiGet<{ profile: CustomerProfile }>("/v1/me/profile"),
          apiGet<{ accounts: Account[] }>("/v1/me/accounts"),
          apiGet<{ cards: CustomerCard[] }>("/v1/me/cards")
        ]);
        setProfile(profileResult.profile);
        setAccounts(accountResult.accounts);
        setCards(cardResult.cards);
        setCustomerMessage("Customer registration record, account status, and available card metadata loaded.");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "CUSTOMER_DATA_UNAVAILABLE";
      if (message !== "AUTHENTICATION_REQUIRED") {
        setCustomerMessage(message === "CUSTOMER_PROFILE_NOT_FOUND"
          ? "This signed-in identity is not mapped to a FlowPay customer profile yet."
          : message === "AUTH_NOT_CONFIGURED"
            ? "The backend Neon Auth issuer, audience, and JWKS settings are not configured."
            : message === "CUSTOMER_DATA_UNAVAILABLE"
              ? "Customer data is unavailable. Check the additive migration and API logs."
              : `Customer data unavailable: ${message}`);
      }
      if (target === "Overview") setSummaryTotals([]);
      if (target === "Cards") { setCards([]); setCardEvents([]); }
      if (target === "Customer Profile" || target === "View Account Number") { setProfile(null); setAccounts([]); }
      setTransactions([]);
    } finally {
      setCustomerLoading(false);
    }
  }

  useEffect(() => {
    void checkApi();
  }, []);

  useEffect(() => {
    void loadCustomerData(page);
  }, [page, activityFilter]);

  const nav = [
    { name: "Overview" as const, icon: Home },
    { name: "Money Received" as const, icon: ArrowDownLeft },
    { name: "Money Sent" as const, icon: ArrowUpRight },
    { name: "Transfers" as const, icon: ArrowLeftRight },
    { name: "Bulk Payments" as const, icon: Banknote },
    { name: "Bulk Verification" as const, icon: ShieldCheck },
    { name: "Cards" as const, icon: CreditCard },
    { name: "Activity" as const, icon: Clock3 },
    { name: "Customer Profile" as const, icon: UserRound },
    { name: "View Account Number" as const, icon: Eye }
  ];

  const pathname = window.location.pathname.replace(/\/+$/, "") || "/";
  if (pathname === "/") return <LandingPage />;
  if (pathname === "/login" || pathname === "/signin") return <AuthPage mode="login" />;
  if (pathname === "/signup" || pathname === "/register" || pathname === "/registration") return <AuthPage mode="signup" />;
  if (pathname === "/logout" || pathname === "/signout") return <LogoutPage />;

  return (
    <div className="app-shell">
      <aside className={`sidebar ${menuOpen ? "sidebar-open" : ""}`}>
        <div className="brand">
          <span className="brand-mark">F</span>
          <span>flow<span className="brand-accent">pay</span></span>
          <button className="icon-button mobile-close" onClick={() => setMenuOpen(false)} aria-label="Close menu">
            <X size={20} />
          </button>
        </div>

        <div className="workspace-label">YOUR FINANCES</div>
        <nav>
          {nav.map(({ name, icon: Icon }) => (
            <button
              key={name}
              className={`nav-item ${page === name ? "nav-active" : ""}`}
              aria-current={page === name ? "page" : undefined}
              onClick={() => {
                setPage(name);
                window.sessionStorage.setItem("flowpay.currentPage", name);
                setMenuOpen(false);
              }}
            >
              <Icon size={19} />
              <span>{name}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <button className="logout-button" type="button" onClick={() => window.location.assign("/logout")}>
            <LogOut size={18} />
            <span>Log out</span>
          </button>
        </div>
      </aside>

      {menuOpen && <button className="scrim" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />}

      <main className="main">
        <header className="topbar">
          <button className="icon-button mobile-menu" onClick={() => setMenuOpen(true)} aria-label="Open menu">
            <Menu size={22} />
          </button>
          <div className="breadcrumb">Workspace <span>/</span> <strong>{page}</strong></div>
          <div className="topbar-right">
            <span className={`api-indicator api-${apiStatus}`}>
              <span className="status-dot" />
              {apiMessage}
            </span>
            <button className="icon-button notification-button" aria-label="Notifications">
              <Bell size={19} />
            </button>
          </div>
        </header>

        <div className="content">
          <div className="welcome-row">
            <div>
              <div className="eyebrow">YOUR MONEY, IN VIEW</div>
              <h1>{page === "Overview" ? "Welcome to FlowPay" : page}</h1>
              <p className="subtitle">
                {page === "Overview"
                  ? "A clearer view of your financial life starts here."
                  : page === "Cards"
                    ? "Explore card tools while secure issuing services are being built."
                    : page === "Transfers"
                      ? "Review the transfer workflow and the checks required before it can be enabled."
                      : page === "Money Received"
                        ? "Review incoming funds verified against posted ledger entries."
                        : page === "Money Sent"
                          ? "Review outgoing funds verified against posted ledger entries."
                          : page === "Customer Profile"
                            ? "Review your registration record, account details, and virtual card preview."
                            : page === "View Account Number"
                              ? "Review account identifiers and the current bank-account assignment status."
                              : page === "Bulk Payments"
                                ? "Prepare and review multi-beneficiary payment batches; execution remains disabled pending provider approval."
                                : page === "Bulk Verification"
                                  ? "Check beneficiary file formats before connecting an approved bank-account verification provider."
                                  : "Review verified account activity when ledger-backed history is available."}
              </p>
            </div>
            <button
              className="refresh-button"
              onClick={() => { void Promise.all([checkApi(), loadCustomerData(page)]); }}
              aria-label={`Refresh ${page} and connection status`}
              title={`Refresh ${page} data and API/database connection status`}
              disabled={customerLoading}
            >
              <RefreshCw size={16} /> Refresh
            </button>
          </div>

          {page === "Bulk Payments" ? (
            <BulkOperations mode="payments" />
          ) : page === "Bulk Verification" ? (
            <BulkOperations mode="verification" />
          ) : page === "Overview" ? (
            <>
          <section className="notice">
            <div className="notice-icon"><ShieldCheck size={21} /></div>
            <div>
              <strong>FlowPay workspace</strong>
              <p>FlowPay checks API health and database readiness. Account balances, cards, and transaction history are shown only when authenticated services return verified records.</p>
            </div>
          </section>

          <section className="section-heading dashboard-section-heading">
            <div>
              <h2>Account overview</h2>
              <p>Live financial figures will appear only after they can be loaded from authenticated account services.</p>
            </div>
            <span className="preview-label">PREVIEW</span>
          </section>

          <section className="stat-grid dashboard-stat-grid">
            <article className="stat-card balance-card">
              <div className="stat-top"><span>Available balance</span><Wallet size={19} /></div>
              <div className="balance-value">{summaryTotals.length ? summaryTotals.map((total) => formatMinor(total.net_balance_minor, total.currency)).join(" · ") : "Not available"}</div>
              <div className="stat-foot">{summaryTotals.length ? "Posted ledger balances" : "Awaiting verified account data"}</div>
            </article>
            <article className="stat-card stat-card-link" role="button" tabIndex={0} onClick={() => { setPage("Money Received"); window.sessionStorage.setItem("flowpay.currentPage", "Money Received"); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setPage("Money Received"); window.sessionStorage.setItem("flowpay.currentPage", "Money Received"); } }}>
              <div className="stat-top"><span>Money received</span><ArrowDownLeft size={19} /></div>
              <div className="stat-value">{summaryTotals.length ? summaryTotals.map((total) => formatMinor(total.money_received_minor, total.currency)).join(" · ") : "—"}</div>
              <div className="stat-foot">{summaryTotals.length ? "Posted ledger credits" : "Awaiting authenticated ledger data"}</div>
            </article>
            <article className="stat-card stat-card-link" role="button" tabIndex={0} onClick={() => { setPage("Money Sent"); window.sessionStorage.setItem("flowpay.currentPage", "Money Sent"); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setPage("Money Sent"); window.sessionStorage.setItem("flowpay.currentPage", "Money Sent"); } }}>
              <div className="stat-top"><span>Money sent</span><ArrowUpRight size={19} /></div>
              <div className="stat-value">{summaryTotals.length ? summaryTotals.map((total) => formatMinor(total.money_sent_minor, total.currency)).join(" · ") : "—"}</div>
              <div className="stat-foot">{summaryTotals.length ? "Posted ledger debits" : "Awaiting authenticated ledger data"}</div>
            </article>
          </section>

          <section className="quick-actions dashboard-quick-actions" aria-label="Quick navigation">
            <button className="quick-action" onClick={() => { setPage("Transfers"); window.sessionStorage.setItem("flowpay.currentPage", "Transfers"); }}>
              <span className="quick-action-icon"><ArrowLeftRight size={19} /></span>
              <span><strong>Transfers</strong><small>Review secure transfer setup</small></span>
              <span className="quick-action-arrow">↗</span>
            </button>
            <button className="quick-action" onClick={() => { setPage("Cards"); window.sessionStorage.setItem("flowpay.currentPage", "Cards"); }}>
              <span className="quick-action-icon"><CreditCard size={19} /></span>
              <span><strong>Cards</strong><small>Explore card controls</small></span>
              <span className="quick-action-arrow">↗</span>
            </button>
            <button className="quick-action" onClick={() => { setPage("Activity"); window.sessionStorage.setItem("flowpay.currentPage", "Activity"); }}>
              <span className="quick-action-icon"><Clock3 size={19} /></span>
              <span><strong>Activity</strong><small>View activity availability</small></span>
              <span className="quick-action-arrow">↗</span>
            </button>
          </section>

          <section className="lower-grid dashboard-lower-grid">
            <article className="panel activity-panel">
              <div className="panel-heading">
                <div><h2>Recent activity</h2><p>Latest records from the authenticated ledger</p></div>
                <Clock3 size={20} />
              </div>
              {transactions.length ? <div className="transaction-list">
                {transactions.slice(0, 5).map((tx) => <div className="transaction-row" key={tx.id + tx.currency}>
                  <span className="transaction-symbol">{Number(tx.amount_minor) >= 0 ? <ArrowDownLeft size={18} /> : <ArrowUpRight size={18} />}</span>
                  <div className="transaction-copy"><strong>{tx.description || tx.transaction_type}</strong><span>{formatDate(tx.created_at)} · {tx.status}</span></div>
                  <strong className="transaction-amount">{formatMinor(String(Math.abs(Number(tx.amount_minor))), tx.currency)}</strong>
                </div>)}
              </div> : <div className="empty-state">
                <div className="empty-icon"><ArrowLeftRight size={23} /></div>
                <strong>{customerLoading ? "Loading verified activity…" : "No verified activity available"}</strong>
                <span>{customerMessage}</span>
              </div>}
            </article>

            <article className="panel connection-panel">
              <div className="panel-heading">
                <div><h2>System status</h2><p>Frontend to backend connectivity</p></div>
                <CheckCircle2 size={20} />
              </div>
              <div className="connection-row">
                <span>Customer interface</span><span className="status-ok"><CheckCircle2 size={15} /> Running</span>
              </div>
              <div className="connection-row">
                <span>API health endpoint</span>
                <span className={apiStatus === "connected" ? "status-ok" : apiStatus === "checking" ? "status-wait" : "status-error"}>
                  <span className="status-dot" />{apiStatus === "connected" ? "Connected" : apiStatus === "checking" ? "Checking" : "Unavailable"}
                </span>
              </div>
              <div className="connection-row">
                <span>Database readiness{databaseName ? ` (${databaseName})` : ""}</span>
                <span className={databaseStatus === "connected" ? "status-ok" : databaseStatus === "checking" ? "status-wait" : "status-error"}>
                  <span className="status-dot" />
                  {databaseStatus === "connected" ? "Connected" : databaseStatus === "checking" ? "Checking" : databaseStatus === "not_configured" ? "Not configured" : databaseStatus === "schema_incomplete" ? "Schema incomplete" : "Unavailable"}
                </span>
              </div>
              <div className="connection-row">
                <span>Payments</span><span className="status-wait">Disabled</span>
              </div>
              <p className="connection-help">API status comes from <code>/health</code>; database and required schema migrations are checked by <code>/ready</code>. “Schema incomplete” means a required migration is missing; migrations are never applied automatically. A connected database does not mean payment features are enabled.</p>
            </article>
          </section>

            </>
          ) : page === "Cards" ? (
            <section className="page-grid">
              <section className="notice">
                <div className="notice-icon"><ShieldCheck size={21} /></div>
                <div>
                  <strong>Card management and security status</strong>
                  <p>Card records are loaded only from the authenticated customer API. Issuance, ordering, activation, freezing, PIN changes, and spending-limit updates remain disabled until an issuing provider is configured.</p>
                </div>
              </section>
              <section className="section-heading">
                <div><h2>Your cards</h2><p>Card management becomes available after secure issuing services are implemented.</p></div>
                <span className="preview-label">PREVIEW</span>
              </section>
              <p className="feature-feedback" role="status">{customerLoading ? "Loading customer card data…" : customerMessage}</p>
              <section className="customer-card-list">
                {cards.length ? cards.map((card) => <article className="panel customer-card-record" key={card.id}>
                  <div className="customer-card-record-top">
                    <div className="feature-icon"><CreditCard size={22} /></div>
                    <span className={`card-status-pill card-status-${card.status}`}>{card.status}</span>
                  </div>
                  <h3>{card.card_type === "virtual" ? "Virtual card" : "Physical card"}</h3>
                  <p>{card.last4 ? `•••• ${card.last4}` : "Card number hidden / not provided"}</p>
                  <span className="card-record-meta">{card.expiry_month && card.expiry_year ? `Expires ${String(card.expiry_month).padStart(2, "0")}/${card.expiry_year}` : "Expiry not available"}</span>
                  <span className="card-record-meta">Added {formatDate(card.created_at)}</span>
                </article>) : <div className="panel card-history-status"><ShieldCheck size={20} /><div><strong>{customerLoading ? "Loading cards…" : "No card records found"}</strong><p>{customerMessage} No virtual or physical card is created by this screen.</p></div></div>}
              </section>
              <section className="card-feature-grid">
                <article className="panel feature-card">
                  <div className="feature-icon"><CreditCard size={24} /></div>
                  <h2>Virtual card</h2>
                  <p>For supported online purchases after card issuance is integrated.</p>
                  <div className="feature-status"><span className="status-dot" /> Provider not configured</div>
                  <button className="feature-button" disabled aria-disabled="true" title="Requires issuing-provider integration">Virtual card issuance unavailable</button>
                </article>
                <article className="panel feature-card">
                  <div className="feature-icon"><Wallet size={24} /></div>
                  <h2>Physical card</h2>
                  <p>Physical card ordering and delivery are not connected to the backend.</p>
                  <div className="feature-status"><span className="status-dot" /> Provider not configured</div>
                  <button className="feature-button" disabled aria-disabled="true" title="Requires issuing-provider integration">Physical card ordering unavailable</button>
                </article>
                <article className="panel feature-card">
                  <div className="feature-icon"><ShieldCheck size={24} /></div>
                  <h2>Card security</h2>
                  <p>Freeze, unfreeze, PIN management, and spending limits require verified card services.</p>
                  <div className="feature-status"><span className="status-dot" /> Not connected</div>
                  <button className="feature-button" disabled aria-disabled="true" title="Card security mutations remain locked">Card security controls locked</button>
                </article>
              </section>
              <section className="panel card-lifecycle">
                <div className="panel-heading">
                  <div><h2>Card lifecycle</h2><p>What must be verified before a real card is usable</p></div>
                  <ShieldCheck size={20} />
                </div>
                <div className="card-lifecycle-row">
                  <span className="lifecycle-number">1</span>
                  <div><strong>Secure card provider</strong><p>Connect a verified issuing provider and keep provider secrets on the server.</p></div>
                  <span className="workflow-status">Not connected</span>
                </div>
                <div className="card-lifecycle-row">
                  <span className="lifecycle-number">2</span>
                  <div><strong>Authenticate cardholder</strong><p>Require an authenticated customer session and confirm ownership of the card.</p></div>
                  <span className="workflow-status">Not implemented</span>
                </div>
                <div className="card-lifecycle-row">
                  <span className="lifecycle-number">3</span>
                  <div><strong>Audit every control</strong><p>Verify freeze, unfreeze, PIN, limits, and status changes through server-side authorization.</p></div>
                  <span className="workflow-status">Not implemented</span>
                </div>
                <p className="connection-help">The buttons above only explain feature readiness. They do not issue, activate, freeze, or modify a real card.</p>
              </section>
              <section className="panel card-history-panel">
                <div className="panel-heading">
                  <div><h2>Card activity and history</h2><p>Issuance, status changes, and card transactions when verified services are connected</p></div>
                  <Clock3 size={20} />
                </div>
                <div className="card-history-status" role="status">
                  <span className="status-dot" />
                  <div><strong>{customerLoading ? "Loading card history…" : cardEvents.length ? `${cardEvents.length} card audit events loaded` : "No verified card history available"}</strong><p>{cardEvents.length ? "Events are read-only and scoped to the signed-in customer." : customerMessage}</p></div>
                </div>
                {cardEvents.map((event) => <div className="transaction-row" key={event.id}>
                  <span className="transaction-symbol"><ShieldCheck size={18} /></span>
                  <div className="transaction-copy"><strong>{event.event_type}</strong><span>{formatDate(event.created_at)} · {event.outcome}</span></div>
                </div>)}
                <div className="history-footer">
                  <p>Card events are read-only. Issuance, freeze, and PIN changes are not available from this preview.</p>
                  <button className="refresh-button" disabled={customerLoading} onClick={() => { void loadCustomerData("Cards"); }}>Refresh card history</button>
                </div>
                <button className="feature-button" onClick={() => {
                  setActivityFilter("cards");
                  setPage("Activity");
                  window.sessionStorage.setItem("flowpay.currentPage", "Activity");
                }}>Open card history</button>
              </section>
            </section>
          ) : page === "Transfers" ? (
            <section className="page-grid transfer-page">
              <section className="notice">
                <div className="notice-icon"><ShieldCheck size={21} /></div>
                <div>
                  <strong>Transfers are locked for your protection</strong>
                  <p>This preview does not submit transfers or change balances. Transfer controls stay disabled until account authentication, recipient verification, ledger posting, and transaction monitoring are implemented and tested.</p>
                </div>
              </section>

              <section className="transfer-summary panel">
                <div className="transfer-summary-copy">
                  <div className="eyebrow">SECURE TRANSFER WORKFLOW</div>
                  <h2>Before money can move</h2>
                  <p>Every step below must be implemented and verified on the server. A dashboard status alone never authorizes a payment.</p>
                </div>
                <span className="locked-pill" role="status" aria-label="Live transfers disabled"><ShieldCheck size={14} /> Live transfers disabled</span>
              </section>

              <section className="workflow-grid" aria-label="Transfer security requirements">
                <article className="panel workflow-step">
                  <span className="workflow-number">01</span>
                  <div className="workflow-step-heading"><ShieldCheck size={19} /><span>Authenticate customer</span></div>
                  <p>Verify the signed-in customer and confirm they can access the source account.</p>
                  <span className="workflow-status">Not implemented</span>
                </article>
                <article className="panel workflow-step">
                  <span className="workflow-number">02</span>
                  <div className="workflow-step-heading"><CheckCircle2 size={19} /><span>Validate recipient</span></div>
                  <p>Resolve the bank and account details through a trusted provider before review.</p>
                  <span className="workflow-status">Not connected</span>
                </article>
                <article className="panel workflow-step">
                  <span className="workflow-number">03</span>
                  <div className="workflow-step-heading"><Wallet size={19} /><span>Check and post ledger</span></div>
                  <p>Check available funds, limits, idempotency, and balanced double-entry posting.</p>
                  <span className="workflow-status">Validation required</span>
                </article>
                <article className="panel workflow-step">
                  <span className="workflow-number">04</span>
                  <div className="workflow-step-heading"><Clock3 size={19} /><span>Record outcome</span></div>
                  <p>Keep an audit trail and reconcile pending, successful, reversed, or failed transfers.</p>
                  <span className="workflow-status">Not implemented</span>
                </article>
              </section>

              <section className="panel transfer-lock-panel">
                <div className="transfer-lock-icon"><ShieldCheck size={22} /></div>
                <div className="transfer-lock-copy">
                  <h2>Transfer action unavailable</h2>
                  <p>No live provider-backed transfer flow is enabled. Any development/simulated transfer path is not a real bank transfer and does not authorize customer funds to move. This control remains disabled until provider approval, recipient verification, ledger safeguards, idempotency, and reconciliation are verified end-to-end.</p>
                </div>
                <button className="feature-button transfer-disabled-button" disabled aria-disabled="true">Transfers not available</button>
              </section>
            </section>
          ) : page === "Security" ? (
            <section className="page-grid profile-page">
              <section className="notice">
                <div className="notice-icon"><ShieldCheck size={21} /></div>
                <div><strong>Account security</strong><p>Passkeys add a cryptographic verification step to your existing signed-in account. Email/password login remains available. Passkeys here do not yet replace Neon Auth sign-in.</p></div>
              </section>
              <PasskeySecurity apiUrl={API_URL} getAccessToken={getAccessToken} />
              <section className="notice">
                <div className="notice-icon"><LockKeyhole size={21} /></div>
                <div><strong>Face-liveness verification is not active yet</strong><p>FlowPay will not claim face verification until a provider is configured, server callbacks are verified, and the provider's face match is tied to your own enrolled identity. No universal master face is used.</p></div>
              </section>
            </section>
          ) : page === "Customer Profile" ? (
            <section className="page-grid profile-page">
              <section className="notice">
                <div className="notice-icon"><LockKeyhole size={21} /></div>
                <div><strong>Customer-scoped profile</strong><p>Registration data is shown only from the authenticated customer API. Fields not supplied by the backend are marked unavailable rather than guessed or saved locally.</p></div>
              </section>

              <section className="panel profile-summary-panel">
                <div className="panel-heading"><div><h2>Registration details</h2><p>Details currently returned by your FlowPay profile</p></div><button className="refresh-button" disabled={customerLoading} onClick={() => { void loadCustomerData("Customer Profile"); }}>{customerLoading ? "Refreshing…" : "Refresh profile"}</button></div>
                {profile ? <div className="profile-detail-grid">
                  <div><span>Customer reference</span><strong>{profile.id || "Unavailable"}</strong></div>
                  <div><span>Registered email</span><strong>{profile.email || "Not provided by profile API"}</strong></div>
                  <div><span>Account status</span><strong className={profile.status === "active" ? "status-ok" : profile.status ? "status-error" : "status-wait"}>{profile.status || "Not returned"}</strong></div>
                  <div><span>Registration date</span><strong>{profile.created_at ? formatDate(profile.created_at) : "Not returned"}</strong></div>
                </div> : <div className="empty-state"><div className="empty-icon"><UserRound size={23} /></div><strong>{customerLoading ? "Loading registration details…" : "Registration details unavailable"}</strong><span>{customerMessage}</span></div>}
                <div className="registration-unavailable">
                  <strong>Additional registration fields</strong>
                  <p>Full name, phone number, residential address, date of birth, and identity-verification status are not currently returned by the FlowPay profile API. They are not inferred or stored by this screen.</p>
                </div>
              </section>

              <section className="panel">
                <div className="panel-heading"><div><h2>Account details</h2><p>Internal account references and posted-ledger balances</p></div><Wallet size={20} /></div>
                {accounts.length ? accounts.map((account) => <div className="profile-account-row" key={account.id}>
                  <div className="profile-account-copy">
                    <strong>{account.currency} account</strong>
                    <span>Account reference: {account.id}</span>
                    <span>Status: {account.status}</span>
                    <span>Posted ledger balance: {formatMinor(account.ledger_balance_minor, account.currency)}</span>
                  </div>
                  <button className="feature-button" onClick={() => { setPage("View Account Number"); window.sessionStorage.setItem("flowpay.currentPage", "View Account Number"); }}>View account number</button>
                </div>) : <div className="empty-state"><strong>{customerLoading ? "Loading accounts…" : "No customer accounts available"}</strong><span>{customerMessage}</span></div>}
                <p className="connection-help">An internal account reference is not a bank account number. A bank account number appears here only after a verified provider assignment is returned by the backend.</p>
              </section>

              <section className="panel profile-virtual-card-panel">
                <div className="panel-heading"><div><h2>Virtual card</h2><p>Card appearance preview and any existing card metadata</p></div><CreditCard size={20} /></div>
                {(() => {
                  const virtualCard = cards.find((card) => card.card_type === "virtual");
                  return <div className="profile-card-layout">
                    <div className={`virtual-card-art ${virtualCard ? "virtual-card-issued" : ""}`}>
                      <div className="virtual-card-top"><span className="virtual-card-brand">flow<span>pay</span></span><span className="virtual-card-chip" aria-hidden="true" /></div>
                      <div className="virtual-card-number">{virtualCard?.last4 ? `••••  ••••  ••••  ${virtualCard.last4}` : "••••  ••••  ••••  ••••"}</div>
                      <div className="virtual-card-bottom"><div><span>CARDHOLDER</span><strong>{profile?.email || "FlowPay customer"}</strong></div><div><span>EXPIRES</span><strong>{virtualCard?.expiry_month && virtualCard?.expiry_year ? `${String(virtualCard.expiry_month).padStart(2, "0")}/${String(virtualCard.expiry_year).slice(-2)}` : "— — / — —"}</strong></div></div>
                      <div className="virtual-card-watermark" aria-hidden="true">F</div>
                    </div>
                    <div className="virtual-card-info">
                      <span className={`card-status-pill ${virtualCard ? `card-status-${virtualCard.status}` : "card-status-pending"}`}>{virtualCard ? virtualCard.status : "Preview only"}</span>
                      <strong>{virtualCard ? "Virtual card record found" : "Virtual card not issued"}</strong>
                      <p>{virtualCard ? "Only masked card metadata is shown. Full card number, security code, and PIN are never displayed here." : "This is a visual design preview, not an active payment card. No card number has been generated."}</p>
                      <button className="feature-button" onClick={() => { setPage("Cards"); window.sessionStorage.setItem("flowpay.currentPage", "Cards"); }}>Open card management</button>
                    </div>
                  </div>;
                })()}
              </section>

              <section className="panel profile-security-note">
                <ShieldCheck size={22} /><div><strong>Profile and card security</strong><p>Only authenticated customer-scoped data is shown. Passwords, session tokens, full card numbers, card security codes, and PINs are never displayed. Card issuance and account-number assignment are not triggered by this page.</p></div>
              </section>
            </section>
          ) : page === "View Account Number" ? (
            <section className="page-grid account-number-page">
              <section className="notice">
                <div className="notice-icon"><ShieldCheck size={21} /></div>
                <div><strong>Verified account details only</strong><p>This page does not convert an internal FlowPay account ID into a bank account number. Bank account details appear only when a verified provider assignment is available from the backend.</p></div>
              </section>
              <section className="panel">
                <div className="panel-heading"><div><h2>View account number</h2><p>Your account and bank-assignment status</p></div><button className="refresh-button" disabled={customerLoading} onClick={() => { void loadCustomerData("View Account Number"); }}>{customerLoading ? "Refreshing…" : "Refresh details"}</button></div>
                {accounts.length ? accounts.map((account) => <article className="account-number-card" key={account.id}>
                  <div className="account-number-card-top"><div className="feature-icon"><Building2 size={22} /></div><span className={account.status === "active" ? "status-ok" : account.status === "pending" ? "status-wait" : "status-error"}>{account.status || "Status not returned"}</span></div>
                  <span className="account-number-label">{account.currency} account</span>
                  <strong className="account-number-value">Not available</strong>
                  <p className="account-number-help">Provider assignment: pending integration. A real bank account number is not currently available from the API. Do not use the internal account reference for bank transfers or deposits.</p>
                  <div className="account-number-meta"><span>Internal account reference</span><code>{account.id}</code></div>
                  <div className="account-number-meta"><span>Currency</span><strong>{account.currency}</strong></div>
                  <div className="account-number-meta"><span>Ledger status</span><strong>{account.status}</strong></div>
                  <div className="account-number-meta"><span>Posted ledger balance</span><strong>{formatMinor(account.ledger_balance_minor, account.currency)}</strong></div>
                </article>) : <div className="empty-state"><div className="empty-icon"><Building2 size={23} /></div><strong>{customerLoading ? "Loading account details…" : "Account details unavailable"}</strong><span>{customerMessage}</span></div>}
                <p className="connection-help" role="status">{customerLoading ? "Checking account details…" : accounts.length ? "Account details reflect the latest successful customer API load. Provider assignment remains unavailable until a verified provider response is integrated." : customerMessage}</p>
              </section>
              <button className="feature-button account-back-button" onClick={() => { setPage("Customer Profile"); window.sessionStorage.setItem("flowpay.currentPage", "Customer Profile"); }}>Back to customer profile</button>
            </section>
          ) : page === "Money Received" || page === "Money Sent" ? (
            <section className="page-grid activity-page">
              <section className="notice"><div className="notice-icon"><ShieldCheck size={21} /></div><div><strong>Read-only ledger history</strong><p>These totals and records come from posted ledger entries only. No payment is created or initiated from this page.</p></div></section>
              <section className="panel activity-history-panel">
                <div className="panel-heading"><div><h2>{page}</h2><p>{page === "Money Received" ? "Incoming posted ledger entries" : "Outgoing posted ledger entries"}</p></div>{page === "Money Received" ? <ArrowDownLeft size={20} /> : <ArrowUpRight size={20} />}</div>
                <div className="history-readiness-grid">
                  {summaryTotals.map((total) => <div className="history-readiness-item" key={total.currency}><span>{total.currency} {page === "Money Received" ? "received" : "sent"}</span><strong>{formatMinor(page === "Money Received" ? total.money_received_minor : total.money_sent_minor, total.currency)}</strong></div>)}
                </div>
                {!summaryTotals.length && !customerLoading && <p className="connection-help">Verified totals are unavailable. Check the signed-in session and API/database readiness before relying on this view.</p>}
                {transactions.map((tx) => <div className="transaction-row" key={tx.id + tx.currency}>
                  <span className="transaction-symbol">{page === "Money Received" ? <ArrowDownLeft size={18} /> : <ArrowUpRight size={18} />}</span>
                  <div className="transaction-copy"><strong>{tx.description || tx.transaction_type}</strong><span>{formatDate(tx.created_at)} · {tx.status} · {tx.currency}</span></div>
                  <strong className="transaction-amount">{formatMinor(String(Math.abs(Number(tx.amount_minor))), tx.currency)}</strong>
                </div>)}
                {!transactions.length && <div className="empty-state" role="status"><div className="empty-icon"><Clock3 size={23} /></div><strong>{customerLoading ? "Loading ledger records…" : "No verified records available"}</strong><span>{customerMessage}</span></div>}
                <div className="history-footer"><p role="status">{customerMessage}</p><button className="refresh-button" disabled={customerLoading} onClick={() => { void loadCustomerData(page); }}>Refresh history</button></div>
              </section>
            </section>
          ) : (
            <section className="page-grid activity-page">
              <section className="notice">
                <div className="notice-icon"><ShieldCheck size={21} /></div>
                <div>
                  <strong>Your activity</strong>
                  <p>Review transaction history and card events returned by your authenticated account. Transfer records appear only when the API provides them.</p>
                </div>
              </section>
              <section className="panel activity-history-panel">
                <div className="panel-heading">
                  <div><h2>Activity history</h2><p>Filter the history view by activity type</p></div>
                  <Clock3 size={20} />
                </div>
                <div className="history-filters" role="group" aria-label="Filter activity history">
                  <button className={activityFilter === "all" ? "history-filter history-filter-active" : "history-filter"} onClick={() => setActivityFilter("all")}>All activity</button>
                  <button className={activityFilter === "received" ? "history-filter history-filter-active" : "history-filter"} onClick={() => setActivityFilter("received")}>Money received</button>
                  <button className={activityFilter === "sent" ? "history-filter history-filter-active" : "history-filter"} onClick={() => setActivityFilter("sent")}>Money sent</button>
                  <button className={activityFilter === "transfers" ? "history-filter history-filter-active" : "history-filter"} onClick={() => setActivityFilter("transfers")}>Transfers</button>
                  <button className={activityFilter === "cards" ? "history-filter history-filter-active" : "history-filter"} onClick={() => setActivityFilter("cards")}>Card activity</button>
                </div>
                <div className="history-readiness-grid">
                  <div className="history-readiness-item"><span>API connection</span><strong className={apiStatus === "connected" ? "status-ok" : apiStatus === "checking" ? "status-wait" : "status-error"}>{apiStatus === "connected" ? "Connected" : apiStatus === "checking" ? "Checking" : "Unavailable"}</strong></div>
                  <div className="history-readiness-item"><span>Database readiness</span><strong className={databaseStatus === "connected" ? "status-ok" : databaseStatus === "checking" ? "status-wait" : "status-error"}>{databaseStatus === "connected" ? "Connected" : databaseStatus === "checking" ? "Checking" : databaseStatus === "not_configured" ? "Not configured" : databaseStatus === "schema_incomplete" ? "Schema incomplete" : "Unavailable"}</strong></div>
                  <div className="history-readiness-item"><span>Selected view</span><strong>{activityFilter === "all" ? "All activity" : activityFilter === "received" ? "Money received" : activityFilter === "sent" ? "Money sent" : activityFilter === "transfers" ? "Transfers" : "Card activity"}</strong></div>
                </div>
                <div className="history-empty-state">
                  <div className="empty-icon">{activityFilter === "cards" ? <CreditCard size={23} /> : activityFilter === "transfers" ? <ArrowLeftRight size={23} /> : <Clock3 size={23} />}</div>
                  <strong>{activityFilter === "cards"
                    ? cardEvents.length ? `${cardEvents.length} card events loaded` : "Card history is empty"
                    : transactions.length ? `${transactions.length} verified records` : "No verified transaction history"}</strong>
                  <span>{activityFilter === "cards" && cardEvents.length
                    ? "These read-only events belong to cards owned by the signed-in customer."
                    : transactions.length ? "These records were returned by the authenticated customer-scoped API." : customerMessage}</span>
                </div>
                {activityFilter === "cards" && cardEvents.map((event) => <div className="transaction-row" key={event.id}>
                  <span className="transaction-symbol"><ShieldCheck size={18} /></span>
                  <div className="transaction-copy"><strong>{event.event_type}</strong><span>{formatDate(event.created_at)} · {event.outcome}</span></div>
                </div>)}
                {transactions.map((tx) => <div className="transaction-row" key={tx.id + tx.currency}>
                  <span className="transaction-symbol">{Number(tx.amount_minor) >= 0 ? <ArrowDownLeft size={18} /> : <ArrowUpRight size={18} />}</span>
                  <div className="transaction-copy"><strong>{tx.description || tx.transaction_type}</strong><span>{formatDate(tx.created_at)} · {tx.status} · {tx.currency}</span></div>
                  <strong className="transaction-amount">{formatMinor(String(Math.abs(Number(tx.amount_minor))), tx.currency)}</strong>
                </div>)}
                <div className="history-footer">
                  <p>{customerMessage}</p>
                  <button className="refresh-button" disabled={customerLoading} onClick={() => { void checkApi(); void loadCustomerData(page); }}>Refresh data</button>
                </div>
              </section>
            </section>
          )}
          <footer>
            <span>© {new Date().getFullYear()} FlowPay</span>
            <span>Your financial workspace</span>
          </footer>
        </div>
      </main>
    </div>
  );
}
