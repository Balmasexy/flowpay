import { useEffect, useMemo, useState } from "react";
import AdminPage from "./AdminPage";
import LandingPage from "./LandingPage";
import LoginPage from "./LoginPage";
import {
  Activity, ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Cable,
  ChevronRight, CircleHelp, Clock3, CreditCard, FileText, Home,
  LockKeyhole, Phone, ShieldCheck, UserRound, Wallet, Wifi, Zap
} from "lucide-react";

type Route = {
  path: string; label: string; icon: typeof Home; group: "main" | "services" | "account";
};
const routes: Route[] = [
  { path: "/dashboard", label: "Home", icon: Home, group: "main" },
  { path: "/transfers", label: "Transfers", icon: ArrowLeftRight, group: "main" },
  { path: "/cards", label: "Cards", icon: CreditCard, group: "main" },
  { path: "/activity", label: "Transaction history", icon: Activity, group: "main" },
  { path: "/airtime", label: "Airtime", icon: Phone, group: "services" },
  { path: "/data", label: "Data", icon: Wifi, group: "services" },
  { path: "/bills", label: "Bill payments", icon: Zap, group: "services" },
  { path: "/cable-tv", label: "Cable TV", icon: Cable, group: "services" },
  { path: "/savings", label: "Savings", icon: Wallet, group: "services" },
  { path: "/profile", label: "My profile", icon: UserRound, group: "account" },
  { path: "/documents", label: "Documents", icon: FileText, group: "account" },
  { path: "/security", label: "Security", icon: LockKeyhole, group: "account" },
  { path: "/support", label: "Help & support", icon: CircleHelp, group: "account" },
];

const providers = ["MTN", "Airtel", "Glo", "9mobile"];
const services = [
  { label: "Airtime", path: "/airtime", icon: Phone, detail: "Top up any Nigerian network" },
  { label: "Data", path: "/data", icon: Wifi, detail: "Buy data bundles" },
  { label: "Transfers", path: "/transfers", icon: ArrowLeftRight, detail: "Send money to a bank" },
  { label: "Cards", path: "/cards", icon: CreditCard, detail: "Manage virtual and physical cards" },
  { label: "Electricity", path: "/bills", icon: Zap, detail: "Pay electricity bills" },
  { label: "Cable TV", path: "/cable-tv", icon: Cable, detail: "Pay TV subscriptions" },
  { label: "Savings", path: "/savings", icon: Wallet, detail: "Savings tools and goals" },
  { label: "History", path: "/activity", icon: Clock3, detail: "Track every transaction" },
];

function routeFor(path: string) {
  return routes.find((r) => r.path === path) ?? routes[0];
}

export default function App() {
  const [path, setPath] = useState(() => window.location.pathname);
  const [network, setNetwork] = useState("Airtel");
  const [phone, setPhone] = useState("");
  const [amount, setAmount] = useState("");

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const active = useMemo(() => routeFor(path), [path]);
  const go = (next: string) => {
    if (next !== window.location.pathname) window.history.pushState({}, "", next);
    setPath(next);
    window.scrollTo({ top: 0, behavior: "auto" });
  };
  const servicePage = ["/airtime", "/data", "/bills", "/cable-tv"].includes(path);

  if (path === "/dashboard") return <LandingPage />;
  if (path === "/login") return <LoginPage />;
  if (path === "/admin" || path.startsWith("/admin/")) return <AdminPage />;

  return (
    <div className="flowpay-app">
      <header className="fp-header">
        <button className="fp-brand" onClick={() => go("/")} aria-label="FlowPay home">
          <span className="fp-logo">F</span><span>flow<span>pay</span></span>
        </button>
        <div className="fp-header-actions">
          <button className="fp-header-link" onClick={() => go("/support")}><CircleHelp size={18}/> Help</button>
          <button className="fp-avatar" onClick={() => go("/profile")} aria-label="Open profile"><UserRound size={19}/></button>
        </div>
      </header>

      <div className="fp-layout">
        <main className="fp-main">
          <div className="fp-page-heading">
            <div><span className="fp-eyebrow">FLOWPAY ACCOUNT</span><h1>{path === "/" ? "Good day" : active.label}</h1>
              <p>{path === "/" ? "Your money, services and account—all in one place." : pageDescription(path)}</p>
            </div>
            {path === "/" && <button className="fp-outline" onClick={() => go("/profile")}><UserRound size={16}/> My profile</button>}
          </div>

          {path === "/" ? (
            <>
              <section className="fp-balance">
                <div className="fp-balance-top"><span>Available balance</span><Wallet size={20}/></div>
                <strong>₦ — —</strong>
                <small>Balance will appear when your secure account is connected.</small>
                <div className="fp-balance-actions">
                  <button onClick={() => go("/transfers")}> <ArrowDownLeft size={17}/> Add money</button>
                  <button onClick={() => go("/transfers")}><ArrowUpRight size={17}/> Send money</button>
                </div>
              </section>
              <section className="fp-section">
                <div className="fp-section-title"><h2>Quick services</h2><span>Everyday banking</span></div>
                <div className="fp-service-grid">
                  {services.map(({label, path: target, icon: Icon, detail}) => (
                    <button className="fp-service-tile" key={target} onClick={() => go(target)}>
                      <span className="fp-service-icon"><Icon size={21}/></span><b>{label}</b><small>{detail}</small>
                    </button>
                  ))}
                </div>
              </section>
              <section className="fp-section">
                <div className="fp-section-title"><h2>Mobile networks</h2><span>Airtime and data</span></div>
                <div className="fp-network-row">{providers.map((p) => <button key={p} className="fp-network" onClick={() => {setNetwork(p);go("/airtime");}}>{p}</button>)}</div>
              </section>
              <section className="fp-section fp-activity-preview">
                <div className="fp-section-title"><h2>Recent activity</h2><button onClick={() => go("/activity")}>See all <ChevronRight size={15}/></button></div>
                <div className="fp-empty"><Clock3 size={23}/><b>No verified transactions yet</b><span>Your actual ledger activity will appear here after account services are connected.</span></div>
              </section>
            </>
          ) : servicePage ? (
            <section className="fp-panel fp-form-panel">
              <div className="fp-form-icon">{path === "/airtime" ? <Phone/> : path === "/data" ? <Wifi/> : path === "/cable-tv" ? <Cable/> : <Zap/>}</div>
              <h2>{active.label}</h2>
              <p className="fp-muted">Choose a provider and enter the details. This form is a preview; it will not debit your wallet or submit a bill payment.</p>
              {path === "/airtime" || path === "/data" ? <>
                <label>Mobile network</label><div className="fp-network-select">{providers.map(p => <button type="button" key={p} className={network === p ? "selected" : ""} onClick={() => setNetwork(p)}>{p}</button>)}</div>
                <label htmlFor="phone">Phone number</label><input id="phone" value={phone} onChange={e => setPhone(e.target.value)} inputMode="numeric" placeholder="080 0000 0000" maxLength={11}/>
              </> : <>
                <label>Service provider</label><select defaultValue=""><option value="" disabled>Select provider</option>{(path === "/cable-tv" ? ["DStv", "GOtv", "StarTimes"] : ["IKEDC", "EKEDC", "AEDC", "IBEDC", "KEDCO", "PHED", "Jos Electricity", "KAEDCO"]).map(x => <option key={x}>{x}</option>)}</select>
                <label>Customer / smartcard / meter number</label><input placeholder="Enter your account number"/>
              </>}
              <label htmlFor="amount">Amount (NGN)</label><input id="amount" value={amount} onChange={e => setAmount(e.target.value)} inputMode="numeric" placeholder="₦ 0.00"/>
              <div className="fp-preview-warning"><ShieldCheck size={17}/> Payments are disabled until authenticated billing, provider verification, ledger posting and webhook reconciliation are live.</div>
              <button className="fp-primary" disabled>Continue (not active)</button>
            </section>
          ) : (
            <RouteContent path={path} go={go}/>
          )}
          <footer className="fp-footer"><span>© {new Date().getFullYear()} FlowPay</span><span>Secure banking experience</span></footer>
        </main>
      </div>

      <nav className="fp-bottom-nav" aria-label="Main navigation">
        {[routes[0], routes[1], routes[2], routes[3], routes[9]].map(({path: target,label,icon: Icon}) =>
          <button key={target} className={active.path === target ? "active" : ""} onClick={() => go(target)}>
            <Icon size={19}/><span>{label === "Transaction history" ? "History" : label === "My profile" ? "Profile" : label}</span>
          </button>)}
      </nav>

    </div>
  );
}

function pageDescription(path: string) {
  const descriptions: Record<string,string> = {
    "/transfers":"Send money and manage transfer requests.",
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
    "/support":"Get help with your FlowPay account."
  };
  return descriptions[path] ?? "Manage your FlowPay account.";
}

function RouteContent({path,go}:{path:string;go:(path:string)=>void}) {
  const unavailable = <div className="fp-preview-warning"><ShieldCheck size={17}/> This service is not connected to a verified FlowPay API yet. No real transaction or account change can be made here.</div>;
  if (path === "/profile") return <section className="fp-panel fp-detail-panel"><div className="fp-profile-hero"><div className="fp-profile-avatar"><UserRound size={30}/></div><div><h2>Customer profile</h2><p>Personal and account information</p></div></div><div className="fp-detail-list">{["Full name","Email address","Phone number","FlowPay account number","Account tier","Account status","Residential address"].map(k=><div key={k}><span>{k}</span><b>Not yet linked</b></div>)}</div><button className="fp-outline" onClick={()=>go("/documents")}><FileText size={16}/> View verification documents</button>{unavailable}</section>;
  if (path === "/documents") return <section className="fp-panel fp-detail-panel"><h2>Documents & statements</h2><p className="fp-muted">Your verification and account documents will be available here after secure document storage is connected.</p><div className="fp-doc-list">{["Government ID (NIN / Driver’s Licence / Passport)","BVN verification receipt","Proof of address","Customer account-opening form","Terms and conditions acceptance","Privacy notice acknowledgement","Monthly account statement","Transaction receipt"].map(d=><div key={d}><FileText size={19}/><span>{d}<small>Not uploaded / not generated</small></span><b>Pending</b></div>)}</div>{unavailable}</section>;
  if (path === "/transfers") return <section className="fp-panel fp-detail-panel"><h2>Transfers</h2><p className="fp-muted">Bank and FlowPay wallet transfers.</p><div className="fp-feature-list">{["Transfer to FlowPay","Transfer to other Nigerian banks","Beneficiary management","Transfer limits and fees","Transfer receipt and status"].map(x=><div key={x}><ArrowLeftRight size={18}/>{x}<span>Coming soon</span></div>)}</div>{unavailable}</section>;
  if (path === "/cards") return <section className="fp-panel fp-detail-panel"><h2>Cards</h2><div className="fp-feature-list">{["Virtual card application","Physical card request and delivery","View card details securely","Freeze / unfreeze card","Change card PIN","Set spending limits"].map(x=><div key={x}><CreditCard size={18}/>{x}<span>Coming soon</span></div>)}</div>{unavailable}</section>;
  if (path === "/activity") return <section className="fp-panel fp-detail-panel"><h2>Transaction history</h2><p className="fp-muted">Search, filter and download account activity and receipts.</p><div className="fp-empty"><Activity size={24}/><b>No verified history available</b><span>Only ledger-confirmed transactions will be displayed here.</span></div>{unavailable}</section>;
  if (path === "/savings") return <section className="fp-panel fp-detail-panel"><h2>Savings</h2><div className="fp-feature-list">{["Savings goals","Recurring savings","Fixed savings","Savings withdrawals","Interest and statements"].map(x=><div key={x}><Wallet size={18}/>{x}<span>Coming soon</span></div>)}</div>{unavailable}</section>;
  if (path === "/security") return <section className="fp-panel fp-detail-panel"><h2>Security centre</h2><div className="fp-feature-list">{["Change password","Passkey / device biometrics","Two-step verification","Trusted devices and sessions","Transaction PIN","Account recovery and lock"].map(x=><div key={x}><LockKeyhole size={18}/>{x}<span>Coming soon</span></div>)}</div>{unavailable}</section>;
  if (path === "/support") return <section className="fp-panel fp-detail-panel"><h2>Help & support</h2><div className="fp-feature-list">{["Report a failed transaction","Account access and recovery","Card support","Airtime and bill-payment support","Complaints and dispute tracking","Frequently asked questions"].map(x=><div key={x}><CircleHelp size={18}/>{x}<span>Help</span></div>)}</div>{unavailable}</section>;
  return <section className="fp-panel fp-detail-panel"><h2>Page not found</h2><button className="fp-primary" onClick={()=>go("/")}>Return to home</button></section>;
}
