import { ShieldCheck, Users, Wallet, ArrowLeftRight, CreditCard, SlidersHorizontal, FileText, Settings, LockKeyhole, Activity } from "lucide-react";

const sections = [
  { label: "Overview", icon: Activity },
  { label: "Customers", icon: Users },
  { label: "Accounts & wallets", icon: Wallet },
  { label: "Transactions", icon: ArrowLeftRight },
  { label: "Cards", icon: CreditCard },
  { label: "Staff & roles", icon: LockKeyhole },
  { label: "Provider controls", icon: SlidersHorizontal },
  { label: "Audit logs", icon: FileText },
  { label: "System settings", icon: Settings },
];

export default function AdminPage() {
  return (
    <div className="fp-admin">
      <aside className="fp-admin-sidebar">
        <div className="fp-admin-brand"><span className="fp-admin-logo">F</span><span>FlowPay <small>ADMINISTRATION</small></span></div>
        <div className="fp-admin-nav-label">WORKSPACE</div>
        <nav aria-label="Super Admin navigation">
          {sections.map(({ label, icon: Icon }, index) => (
            <div className={index === 0 ? "fp-admin-nav-item active" : "fp-admin-nav-item"} key={label}>
              <Icon size={17} /><span>{label}</span>
            </div>
          ))}
        </nav>
        <div className="fp-admin-sidebar-foot"><ShieldCheck size={16}/> Restricted administrator area</div>
      </aside>
      <main className="fp-admin-main">
        <header className="fp-admin-topbar"><span>FlowPay / Super Admin</span><span className="fp-admin-env">SECURE ACCESS REQUIRED</span></header>
        <section className="fp-admin-heading">
          <div><div className="fp-admin-eyebrow">CONTROL CENTRE</div><h1>Super Admin</h1><p>Platform oversight and operational management.</p></div>
        </section>
        <section className="fp-admin-lock">
          <div className="fp-admin-lock-icon"><LockKeyhole size={25}/></div>
          <div className="fp-admin-lock-copy">
            <h2>Administrator verification is not connected</h2>
            <p>This area is reserved for authorized FlowPay Super Admin accounts. The current API does not yet verify administrator sessions and roles, so administrative data and controls are intentionally locked.</p>
            <ul>
              <li>Customer records and account balances are not exposed.</li>
              <li>Staff permissions and provider settings cannot be changed here.</li>
              <li>No transaction, ledger, or payment operation can be initiated.</li>
            </ul>
          </div>
          <div className="fp-admin-status"><span/> Access locked pending server-side role verification</div>
        </section>
        <footer className="fp-admin-footer">© {new Date().getFullYear()} FlowPay · Administrative access is monitored and audited.</footer>
      </main>
    </div>
  );
}
