import { useEffect, useState } from "react";
import {
  ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Bell,
  CheckCircle2, CircleHelp, Clock3, CreditCard, Home,
  Menu, RefreshCw, ShieldCheck, Wallet, X
} from "lucide-react";

const API_URL = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");

type ApiStatus = "checking" | "connected" | "unavailable";
type DatabaseStatus = "checking" | "connected" | "unavailable" | "not_configured";
type Page = "Overview" | "Transfers" | "Cards" | "Activity";

export default function App() {
  const [apiStatus, setApiStatus] = useState<ApiStatus>("checking");
  const [apiMessage, setApiMessage] = useState("Checking API connection…");
  const [databaseStatus, setDatabaseStatus] = useState<DatabaseStatus>("checking");
  const [databaseName, setDatabaseName] = useState<string | null>(null);
  const [page, setPage] = useState<Page>(() => {
    const savedPage = window.sessionStorage.getItem("flowpay.currentPage");
    return savedPage === "Transfers" || savedPage === "Cards" || savedPage === "Activity"
      ? savedPage
      : "Overview";
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const [featureMessage, setFeatureMessage] = useState("Card issuing and controls are not connected to the backend.");

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
      const readiness: { status?: string; database?: string; database_name?: string } = await response.json();
      if (response.ok && readiness.status === "ready" && readiness.database === "connected") {
        setDatabaseStatus("connected");
        setDatabaseName(readiness.database_name ?? null);
      } else {
        setDatabaseStatus(readiness.database === "not_configured" ? "not_configured" : "unavailable");
        setDatabaseName(null);
      }
    } catch {
      setDatabaseStatus("unavailable");
      setDatabaseName(null);
    }
  }

  useEffect(() => {
    void checkApi();
  }, []);

  const nav = [
    { name: "Overview" as const, icon: Home },
    { name: "Transfers" as const, icon: ArrowLeftRight },
    { name: "Cards" as const, icon: CreditCard },
    { name: "Activity" as const, icon: Clock3 }
  ];

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
          <div className="security-note">
            <ShieldCheck size={20} />
            <div>
              <strong>Security first</strong>
              <span>Never share your PIN or password.</span>
            </div>
          </div>
          <div className="profile">
            <div className="avatar">F</div>
            <div className="profile-info">
              <strong>FlowPay</strong>
              <span>Customer preview</span>
            </div>
            <CircleHelp size={18} className="muted-icon" />
          </div>
        </div>
      </aside>

      {menuOpen && <button className="scrim" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />}

      <main className="main">
        <header className="topbar">
          <button className="icon-button mobile-menu" onClick={() => setMenuOpen(true)} aria-label="Open menu">
            <Menu size={22} />
          </button>
          <div className="mobile-brand" aria-label="FlowPay"><span className="brand-mark">F</span><span>flow<span className="brand-accent">pay</span></span></div>
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
                      : "Review verified account activity when ledger-backed history is available."}
              </p>
            </div>
            <button
              className="refresh-button"
              onClick={() => {
                window.sessionStorage.setItem("flowpay.currentPage", page);
                window.location.reload();
              }}
              aria-label="Refresh FlowPay"
              title="Refresh all FlowPay page content and connection status"
            >
              <RefreshCw size={16} /> Refresh
            </button>
          </div>

          {page === "Overview" ? (
            <>
          <section className="notice">
            <div className="notice-icon"><ShieldCheck size={21} /></div>
            <div>
              <strong>Development preview</strong>
              <p>FlowPay now checks the live API health and database-readiness endpoints. Account balances, cards, and transaction history remain hidden until authenticated, ledger-backed services are implemented.</p>
            </div>
          </section>

          <section className="section-heading">
            <div>
              <h2>Account overview</h2>
              <p>Live financial figures will appear only after they can be loaded from authenticated account services.</p>
            </div>
            <span className="preview-label">PREVIEW</span>
          </section>

          <section className="stat-grid">
            <article className="stat-card balance-card">
              <div className="stat-top"><span>Available balance</span><Wallet size={19} /></div>
              <div className="balance-value">Not available</div>
              <div className="stat-foot">Awaiting verified account data</div>
            </article>
            <article className="stat-card">
              <div className="stat-top"><span>Money received</span><ArrowDownLeft size={19} /></div>
              <div className="stat-value">—</div>
              <div className="stat-foot">No transaction data connected</div>
            </article>
            <article className="stat-card">
              <div className="stat-top"><span>Money sent</span><ArrowUpRight size={19} /></div>
              <div className="stat-value">—</div>
              <div className="stat-foot">No transaction data connected</div>
            </article>
          </section>

          <section className="quick-actions" aria-label="Quick navigation">
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

          <section className="lower-grid">
            <article className="panel activity-panel">
              <div className="panel-heading">
                <div><h2>Recent activity</h2><p>Your latest account movements</p></div>
                <Clock3 size={20} />
              </div>
              <div className="empty-state">
                <div className="empty-icon"><ArrowLeftRight size={23} /></div>
                <strong>No activity to display</strong>
                <span>Transactions will appear once the secure ledger and account services are ready.</span>
              </div>
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
                  {databaseStatus === "connected" ? "Connected" : databaseStatus === "checking" ? "Checking" : databaseStatus === "not_configured" ? "Not configured" : "Unavailable"}
                </span>
              </div>
              <div className="connection-row">
                <span>Payments</span><span className="status-wait">Disabled</span>
              </div>
              <p className="connection-help">API status comes from <code>/health</code>; database status comes from <code>/ready</code>. A connected database does not mean account, balance, or payment features are implemented.</p>
            </article>
          </section>

            </>
          ) : page === "Cards" ? (
            <section className="page-grid">
              <section className="notice">
                <div className="notice-icon"><ShieldCheck size={21} /></div>
                <div>
                  <strong>Card services are not connected yet</strong>
                  <p>These card panels are available to explore, but FlowPay has no card-issuing or card-control API yet. No real card is issued or activated from this preview.</p>
                </div>
              </section>
              <section className="section-heading">
                <div><h2>Your cards</h2><p>Card management becomes available after secure issuing services are implemented.</p></div>
                <span className="preview-label">PREVIEW</span>
              </section>
              <p className="feature-feedback" role="status">{featureMessage}</p>
              <section className="card-feature-grid">
                <article className="panel feature-card">
                  <div className="feature-icon"><CreditCard size={24} /></div>
                  <h2>Virtual card</h2>
                  <p>For supported online purchases after card issuance is integrated.</p>
                  <div className="feature-status"><span className="status-dot" /> Not issued</div>
                  <button className="feature-button" onClick={() => setFeatureMessage("Virtual card issuance is not connected. No card has been created.")}>Check virtual card</button>
                </article>
                <article className="panel feature-card">
                  <div className="feature-icon"><Wallet size={24} /></div>
                  <h2>Physical card</h2>
                  <p>Physical card ordering and delivery are not connected to the backend.</p>
                  <div className="feature-status"><span className="status-dot" /> Not issued</div>
                  <button className="feature-button" onClick={() => setFeatureMessage("Physical card ordering and delivery are not connected. No order has been placed.")}>Check physical card</button>
                </article>
                <article className="panel feature-card">
                  <div className="feature-icon"><ShieldCheck size={24} /></div>
                  <h2>Card security</h2>
                  <p>Freeze, unfreeze, PIN management, and spending limits require verified card services.</p>
                  <div className="feature-status"><span className="status-dot" /> Not connected</div>
                  <button className="feature-button" onClick={() => setFeatureMessage("Freeze, PIN, and spending-limit controls need a verified card service before they can be enabled.")}>Check security tools</button>
                </article>
              </section>
            </section>
          ) : page === "Transfers" ? (
            <section className="page-grid">
              <section className="notice">
                <div className="notice-icon"><ShieldCheck size={21} /></div>
                <div>
                  <strong>Transfers are safely disabled</strong>
                  <p>The current API exposes health and readiness endpoints only. No transfer can be submitted, and no balance is changed by this preview.</p>
                </div>
              </section>
              <section className="panel feature-card">
                <div className="feature-icon"><ArrowLeftRight size={24} /></div>
                <h2>Transfer workflow</h2>
                <p>Before transfers can be enabled, FlowPay needs authenticated accounts, server-side double-entry posting, idempotency, limits, and audit events.</p>
                <div className="connection-row"><span>Account authentication</span><span className="status-wait">Not implemented</span></div>
                <div className="connection-row"><span>Ledger posting</span><span className="status-wait">Validation required</span></div>
                <div className="connection-row"><span>Live transfers</span><span className="status-wait">Disabled</span></div>
              </section>
            </section>
          ) : (
            <section className="page-grid">
              <section className="panel activity-panel">
                <div className="panel-heading">
                  <div><h2>Activity history</h2><p>Account movements from the verified ledger</p></div>
                  <Clock3 size={20} />
                </div>
                <div className="empty-state">
                  <div className="empty-icon"><Clock3 size={23} /></div>
                  <strong>No verified activity available</strong>
                  <span>Activity will appear after account authentication and ledger-backed transaction history are implemented. No sample transactions are shown as real.</span>
                </div>
              </section>
            </section>
          )}
          <footer>
            <span>© {new Date().getFullYear()} FlowPay</span>
            <span>Independent product · Development preview</span>
          </footer>
        </div>
        <nav className="mobile-bottom-nav" aria-label="Main navigation">
          {nav.map(({ name, icon: Icon }) => (
            <button key={name} className={`mobile-nav-item ${page === name ? "mobile-nav-active" : ""}`} onClick={() => {
              setPage(name);
              window.sessionStorage.setItem("flowpay.currentPage", name);
              setMenuOpen(false);
            }} aria-current={page === name ? "page" : undefined}>
              <Icon size={20} strokeWidth={page === name ? 2.4 : 1.9} />
              <span>{name === "Overview" ? "Home" : name}</span>
            </button>
          ))}
        </nav>
      </main>
    </div>
  );
}
