import { useEffect, useMemo, useRef, useState } from "react";
import AdminPage from "./AdminPage";
import BulkOperations from "./BulkOperations";
import StoryblokPublicPage from "./StoryblokPublicPage";
import BalmzAiAssistant from "./BalmzAiAssistant";
import LoginPage from "./LoginPage";
import SignupPage from "./SignupPage";
import CustomerProfile from "./CustomerProfile";
import CustomerActivity from "./CustomerActivity";
import CustomerCards from "./CustomerCards";
import MoneyReceived from "./MoneyReceived";
import MoneySent from "./MoneySent";
import SecurityCenter from "./SecurityCenter";
import FaceVerification from "./FaceVerification";
import CustomerAccountDetails from "./CustomerAccountDetails";
import TransfersPage from "./TransfersPage";
import OverviewDashboard from "./OverviewDashboard";
import ServicePreview from "./ServicePreview";
import SavingsPage from "./SavingsPage";
import SpendSavePage from "./SpendSavePage";
import FlowPaySearch from "./FlowPaySearch";
import HelpSupport from "./HelpSupport";
import MorePage from "./MorePage";
import InvitationsPage from "./InvitationsPage";
import BettingPreview from "./BettingPreview";
import DocumentsPage from "./DocumentsPage";
import CustomerNotifications from "./CustomerNotifications";
import { authClient, authConfigured } from "./auth-client";
import {
  Activity, ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Cable,
  ChevronLeft, ChevronRight, CircleHelp, Ellipsis, CreditCard, FileText, Gift, Home,
  LockKeyhole, Phone, Search, ShieldCheck, Smartphone, UserRound, Wallet, Wifi, Zap
} from "lucide-react";

type Route = {
  path: string; label: string; icon: typeof Home; group: "main" | "services" | "account";
};
const routes: Route[] = [
  { path: "/dashboard", label: "Overview", icon: Home, group: "main" },
  { path: "/search", label: "Search", icon: Search, group: "main" },
  { path: "/money-received", label: "Deposit / Add Money", icon: ArrowDownLeft, group: "main" },
  { path: "/money-sent", label: "Transfer History", icon: ArrowUpRight, group: "main" },
  { path: "/transfers", label: "Transfers", icon: ArrowLeftRight, group: "main" },
  { path: "/cards", label: "Cards", icon: CreditCard, group: "main" },
  { path: "/activity", label: "Activity", icon: Activity, group: "main" },
  { path: "/security", label: "Security", icon: LockKeyhole, group: "main" },
  { path: "/bulk-payments", label: "Bulk Payments", icon: Wallet, group: "main" },
  { path: "/bulk-verification", label: "Bulk Verification", icon: ShieldCheck, group: "main" },
  { path: "/airtime", label: "Airtime", icon: Phone, group: "services" },
  { path: "/data", label: "Data", icon: Wifi, group: "services" },
  { path: "/bills", label: "Bill payments", icon: Zap, group: "services" },
  { path: "/cable-tv", label: "Cable TV", icon: Cable, group: "services" },
  { path: "/savings", label: "Savings", icon: Wallet, group: "services" },
  { path: "/profile", label: "Customer Profile", icon: UserRound, group: "account" },
  { path: "/account-number", label: "View Account Number", icon: Smartphone, group: "account" },
  { path: "/documents", label: "Documents", icon: FileText, group: "account" },
  { path: "/betting", label: "Betting", icon: Gift, group: "services" },
  { path: "/tv", label: "TV", icon: Cable, group: "services" },
  { path: "/fixed-savings", label: "Fixed Savings", icon: Wallet, group: "services" },
  { path: "/spend-save", label: "Spend & Save", icon: Wallet, group: "services" },
  { path: "/invitations", label: "Invitations", icon: Gift, group: "services" },
  { path: "/more", label: "More", icon: ChevronRight, group: "account" },
  { path: "/face-verification", label: "Face verification", icon: ShieldCheck, group: "account" },
  { path: "/support", label: "Help & support", icon: CircleHelp, group: "account" },
];


function routeFor(path: string) {
  return routes.find((r) => r.path === path) ?? routes[0];
}

export default function App() {
  const [path, setPath] = useState(() => window.location.pathname);
  const [query, setQuery] = useState(() => window.location.search);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const sidebarScrollRef = useRef<HTMLDivElement>(null);
  const authSession = authClient.useSession();
  const [network, setNetwork] = useState("Airtel");
  const [profilePhoto, setProfilePhoto] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const token = authSession.data?.session?.token;
    const apiBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") || "";
    if (!token || typeof token !== "string" || token.split(".").length !== 3 || !apiBase) {
      setProfilePhoto(null);
      return () => { active = false; };
    }
    fetch(apiBase + "/customer/profile", {
      method: "GET",
      credentials: "omit",
      headers: { Authorization: "Bearer " + token }
    }).then(async response => {
      if (!response.ok) throw new Error("Unable to load customer profile photo");
      return response.json();
    }).then(data => {
      if (active) setProfilePhoto(typeof data.profile?.photoUrl === "string" ? data.profile.photoUrl : null);
    }).catch(() => {
      if (active) setProfilePhoto(null);
    });
    return () => { active = false; };
  }, [authSession.data?.session?.token, authSession.data?.user?.id]);

  useEffect(() => {
    const token = authSession.data?.session?.token;
    const apiBaseRaw = String(import.meta.env.VITE_API_BASE_URL || "");
    const apiBase = apiBaseRaw.endsWith("/") ? apiBaseRaw.slice(0, -1) : apiBaseRaw;
    if (!token || typeof token !== "string" || token.split(".").length !== 3 || !apiBase) return;
    const controller = new AbortController();
    void fetch(apiBase + "/customer/account-details", {
      method: "GET",
      credentials: "omit",
      signal: controller.signal,
      headers: { Authorization: "Bearer " + token }
    }).catch(() => undefined);
    return () => controller.abort();
  }, [authSession.data?.session?.token, authSession.data?.user?.id]);

  useEffect(() => {
    const onPop = () => { setPath(window.location.pathname); setQuery(window.location.search); };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const active = useMemo(() => routeFor(path), [path]);
  useEffect(() => {
    const activeItem = sidebarScrollRef.current?.querySelector<HTMLButtonElement>('[aria-current="page"]');
    activeItem?.scrollIntoView({ block: "nearest" });
  }, [path]);
  const go = (next: string) => {
    const target = new URL(next, window.location.origin);
    const nextPath = target.pathname;
    const nextQuery = target.search;
    if (nextPath !== window.location.pathname || nextQuery !== window.location.search) window.history.pushState({}, "", nextPath + nextQuery);
    setPath(nextPath);
    setQuery(nextQuery);
    setMobileMenuOpen(false);
    window.scrollTo({ top: 0, behavior: "auto" });
  };
  const servicePage = ["/airtime", "/data", "/bills", "/cable-tv", "/tv"].includes(path);

  if (path === "/" || path === "/about" || path === "/services") {
    const slug = path === "/" ? "home" : path.slice(1);
    return <StoryblokPublicPage slug={slug} />;
  }
  if (path === "/login") return <LoginPage />;
  if (path === "/signup" || path === "/register" || path === "/registration") return <SignupPage />;
  if (path === "/admin" || path.startsWith("/admin/")) {
    if (!authConfigured) return <LoginPage />;
    if (authSession.isPending) return <main className="fp-login-page"><section className="fp-login-shell"><div className="fp-login-form-wrap"><h2>Checking administrator session…</h2></div></section></main>;
    if (!authSession.data?.user) { window.location.replace("/login"); return null; }
    return <AdminPage token={authSession.data.session?.token ?? ""} />;
  }
  if (!authConfigured) return <LoginPage />;
  if (authSession.isPending) return <main className="fp-login-page"><section className="fp-login-shell"><div className="fp-login-form-wrap"><h2>Checking your FlowPay session…</h2></div></section></main>;
  if (!authSession.data?.user) { window.location.replace("/login"); return null; }

  return (
    <div className="flowpay-app">
      <header className="fp-header">
        <button className="fp-brand" onClick={() => go("/dashboard")} aria-label="FlowPay dashboard">
          <span className="fp-logo">F</span><span>flow<span>pay</span></span>
        </button>
        <div className="fp-header-actions">
          <CustomerNotifications token={authSession.data.session?.token ?? ""} go={go}/>
          <button className="fp-header-link" onClick={() => go("/support")}><CircleHelp size={18}/> Help</button>
          <button className="fp-avatar" onClick={() => go("/profile")} aria-label="Open profile" style={{width:36,height:36,minWidth:36,minHeight:36,padding:0,borderRadius:"50%",overflow:"hidden",display:"inline-flex",alignItems:"center",justifyContent:"center",flex:"0 0 36px",position:"relative"}}>{profilePhoto || authSession.data.user.image ? <img src={profilePhoto || authSession.data.user.image || ""} alt="" referrerPolicy="no-referrer" style={{display:"block",width:"100%",height:"100%",maxWidth:"100%",maxHeight:"100%",objectFit:"cover",borderRadius:"50%",position:"absolute",inset:0}}/> : <UserRound size={19}/>}</button>
          <button className="fp-header-link" onClick={async () => { await authClient.signOut(); window.location.assign("/login"); }}>Sign out</button>
        </div>
      </header>

      <div className={`fp-layout${sidebarCollapsed ? " fp-sidebar-collapsed" : ""}`}>
        <aside className="fp-sidebar" aria-label="Customer navigation">
          <button className="fp-sidebar-toggle" type="button" onClick={() => setSidebarCollapsed(value => !value)} aria-expanded={!sidebarCollapsed} aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"} title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}>
            {sidebarCollapsed ? <ChevronRight size={18}/> : <ChevronLeft size={18}/>}
            <span>{sidebarCollapsed ? "Expand" : "Collapse"}</span>
          </button>
          <div className="fp-sidebar-scroll" ref={sidebarScrollRef} aria-label="All customer pages">
            {(["main","services","account"] as const).map(group => <div className="fp-sidebar-section" key={group}>
              <span>{group === "main" ? "YOUR FINANCES" : group === "services" ? "PAYMENTS & SERVICES" : "ACCOUNT"}</span>
              {routes.filter(r => r.group === group).map(({path: target,label,icon: Icon}) => <button key={target} className={active.path === target ? "active" : ""} title={label} aria-current={active.path === target ? "page" : undefined} onClick={() => go(target)}><Icon size={17}/><span>{label}</span></button>)}
            </div>)}
          </div>
          <div className="fp-sidebar-foot"><ShieldCheck size={17}/><span>Secure customer access</span></div>
        </aside>
        {sidebarCollapsed && <button className="fp-sidebar-reopen" type="button" onClick={() => setSidebarCollapsed(false)} aria-label="Open navigation menu" title="Open navigation menu"><Ellipsis size={22}/></button>}
        <main className="fp-main">
          <div className="fp-page-heading">
            <div><span className="fp-eyebrow">FLOWPAY ACCOUNT</span><h1>{path === "/dashboard" ? "Good day" : path === "/payment-return/paystack" ? "Payment status" : active.label}</h1>
              {path !== "/dashboard" && <p>{pageDescription(path)}</p>}
            </div>
            {path === "/dashboard"
              ? <button className="fp-outline" onClick={() => go("/profile")}><UserRound size={16}/> My profile</button>
              : <button className="fp-page-back" type="button" onClick={() => {
                  if (window.history.length > 1) window.history.back();
                  else go("/dashboard");
                }}><ChevronLeft size={17}/> Back</button>}
          </div>

          {path === "/dashboard" ? (
            <OverviewDashboard
              token={authSession.data.session?.token ?? ""}
              go={go}
              network={network}
              onNetworkChange={setNetwork}
            />
          ) : servicePage ? (
            <ServicePreview path={path} token={authSession.data.session?.token ?? ""}/>
          ) : (
            path === "/bulk-payments" ? <BulkOperations mode="payments" token={authSession.data.session?.token ?? ""}/> : path === "/bulk-verification" ? <BulkOperations mode="verification" token={authSession.data.session?.token ?? ""}/> : <RouteContent path={path} go={go} user={authSession.data.user} token={authSession.data.session?.token ?? ""} onPhotoChange={setProfilePhoto} transferMode={new URLSearchParams(query).get("mode") === "bank" ? "bank" : "flowpay"}/>
          )}
          <footer className="fp-footer"><span>© {new Date().getFullYear()} FlowPay</span><span>Secure banking experience</span></footer>
        </main>
      </div>

      <nav className="fp-bottom-nav" aria-label="Main navigation">
        {[routes[0], routes[4], routes[7], routes[8]].map(({path: target,label,icon: Icon}) =>
          <button key={target} className={active.path === target ? "active" : ""} title={label} onClick={() => go(target)}>
            <Icon size={19}/><span>{label}</span>
          </button>)}
        <button className={mobileMenuOpen ? "active" : ""} aria-expanded={mobileMenuOpen} aria-controls="fp-mobile-all-menu" onClick={() => setMobileMenuOpen(v => !v)}>
          <ChevronRight size={19}/><span>All services</span>
        </button>
      </nav>
      {mobileMenuOpen && <div className="fp-mobile-menu-overlay" onClick={() => setMobileMenuOpen(false)}>
        <section id="fp-mobile-all-menu" className="fp-mobile-menu" aria-label="All FlowPay navigation" onClick={e => e.stopPropagation()}>
          <div className="fp-mobile-menu-head"><div><b>All FlowPay services</b><small>Every account section and service</small></div><button onClick={() => setMobileMenuOpen(false)} aria-label="Close menu">×</button></div>
          {(["main","services","account"] as const).map(group => <div className="fp-mobile-menu-group" key={group}>
            <span>{group === "main" ? "YOUR FINANCES" : group === "services" ? "PAYMENTS & SERVICES" : "ACCOUNT"}</span>
            {routes.filter(r => r.group === group).map(({path: target,label,icon: Icon}) => <button key={target} className={active.path === target ? "active" : ""} title={label} onClick={() => go(target)}><Icon size={18}/><span>{label}</span><ChevronRight size={15}/></button>)}
          </div>)}
        </section>
      </div>}

      <BalmzAiAssistant token={authSession.data.session?.token ?? ""}/>

    </div>
  );
}

function pageDescription(path: string) {
  const descriptions: Record<string,string> = {
    "/search":"Search your FlowPay account and available services.",
    "/money-received":"Add money and review verified wallet deposits.",
    "/payment-return/paystack":"Check the verified status of your Paystack deposit.",
    "/money-sent":"Review your recorded outgoing transfer history.",
    "/bulk-payments":"Bulk payment tools are restricted until approved business services are connected.",
    "/bulk-verification":"Customer verification tools require approved verification services.",
    "/account-number":"View your assigned FlowPay account number and bank assignment.",
    "/betting":"Betting account funding is unavailable until a verified provider is connected.",
    "/tv":"Manage supported TV subscriptions.",
    "/fixed-savings":"Explore fixed savings options.",
    "/spend-save":"Manage spend-and-save goals.",
    "/invitations":"Invite people to FlowPay when referral services are available.",
    "/more":"More FlowPay account services.",
    "/transfers":"Send money to another FlowPay wallet or a Nigerian bank account.",
    "/cards":"Manage your virtual and physical card services.",
    "/activity":"Search and review your account transaction history.",
    "/airtime":"Recharge MTN, Airtel, Glo and 9mobile numbers.",
    "/data":"Choose a data plan for any supported network.",
    "/bills":"Pay electricity and other supported utility bills.",
    "/cable-tv":"Manage DStv, GOtv and StarTimes subscriptions.",
    "/savings":"Explore savings goals and account saving options.",
    "/profile":"Review your personal and account information.",
    "/documents":"View verification documents and account statements.",
    "/security":"Manage sign-in and account security.",
    "/face-verification":"Complete a secure live selfie and liveness verification with Smile ID sandbox.",
    "/support":"Get help with your FlowPay account."
  };
  return descriptions[path] ?? "Manage your FlowPay account.";
}

function RouteContent({path,go,user,token,onPhotoChange,transferMode}:{path:string;go:(path:string)=>void;user:{name?:string|null;email?:string|null;image?:string|null};token:string;onPhotoChange:(photo:string|null)=>void;transferMode:"flowpay"|"bank"}) {
  if (path === "/search") return <FlowPaySearch go={go}/>;
  if (path === "/money-received") return <MoneyReceived token={token}/>;
  if (path === "/payment-return/paystack") return <MoneyReceived token={token} paymentReturn/>;
  if (path === "/money-sent") return <MoneySent token={token}/>;
  if (path === "/account-number") return <CustomerAccountDetails token={token} go={go}/>;
  if (path === "/more") return <MorePage go={go}/>;
  if (path === "/invitations") return <InvitationsPage/>;
  if (path === "/betting") return <BettingPreview/>;
  if (path === "/bulk-payments" || path === "/bulk-verification") return <section className="fp-panel fp-detail-panel"><h2>{routeFor(path).label}</h2><p className="fp-muted">{pageDescription(path)}</p><div className="fp-preview-warning"><ShieldCheck size={17}/> This section is visible for navigation continuity, but the required provider or approved backend workflow is not connected. No payments, verification requests or account changes can be submitted.</div></section>;
  if (path === "/profile") return <CustomerProfile go={go} user={user} onPhotoChange={onPhotoChange}/>;
  if (path === "/documents") return <DocumentsPage token={token} go={go}/>;
  if (path === "/transfers") return <TransfersPage token={token} initialMode={transferMode}/>;
  if (path === "/cards") return <CustomerCards token={token} registeredName={user.name}/>;
  if (path === "/activity") return <CustomerActivity token={token}/>;
  if (path === "/savings") return <SavingsPage mode="savings"/>;
  if (path === "/fixed-savings") return <SavingsPage mode="fixed"/>;
  if (path === "/spend-save") return <SpendSavePage/>;
  if (path === "/security") return <SecurityCenter token={token}/>;
  if (path === "/face-verification") return <FaceVerification token={token}/>;
  if (path === "/support") return <HelpSupport go={go} token={token}/>;
  return <section className="fp-panel fp-detail-panel"><h2>Page not found</h2><button className="fp-primary" onClick={()=>go("/")}>Return to home</button></section>;
}
