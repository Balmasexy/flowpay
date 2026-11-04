import { ArrowRight, FileText, Gift, HelpCircle, LockKeyhole, ShieldCheck, Smartphone, Wallet, Zap } from "lucide-react";

type Props = { go: (path: string) => void };

const items = [
  { title: "Customer profile", description: "Review your personal details and profile photo.", path: "/profile", icon: Smartphone },
  { title: "Account number", description: "Check your virtual bank-account assignment status.", path: "/account-number", icon: Wallet },
  { title: "Documents & statements", description: "Review available document and statement options.", path: "/documents", icon: FileText },
  { title: "Security centre", description: "Review available sign-in and account-security information.", path: "/security", icon: LockKeyhole },
  { title: "Bulk payments", description: "Prepare and validate a bulk-payment file. Execution is disabled.", path: "/bulk-payments", icon: Zap },
  { title: "Bulk verification", description: "Validate uploaded contact rows. Identity-provider checks are unavailable.", path: "/bulk-verification", icon: ShieldCheck },
  { title: "Invitations", description: "Referral invitations are not yet connected to an active referral service.", path: "/invitations", icon: Gift },
  { title: "Help & support", description: "Search help topics and prepare a support-request draft.", path: "/support", icon: HelpCircle }
];

export default function MorePage({ go }: Props) {
  return <section className="fp-panel fp-detail-panel">
    <h2>More FlowPay services</h2>
    <p className="fp-muted">Open additional account tools and service sections from one place.</p>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 230px), 1fr))", gap: 12, marginTop: 18 }}>
      {items.map(({ title, description, path, icon: Icon }) => <button key={path} type="button" onClick={() => go(path)} style={{ display: "flex", alignItems: "flex-start", gap: 12, textAlign: "left", padding: 15, border: "1px solid var(--fp-border, #d8dee8)", borderRadius: 12, background: "transparent", color: "inherit", cursor: "pointer", minHeight: 104 }}>
        <span style={{ width: 38, height: 38, flex: "0 0 38px", display: "grid", placeItems: "center", borderRadius: 11, background: "rgba(255,122,24,.12)", color: "#ff7a18" }}><Icon size={19}/></span>
        <span style={{ display: "grid", gap: 6, flex: 1 }}><b>{title}</b><small className="fp-muted" style={{ lineHeight: 1.45 }}>{description}</small></span>
        <ArrowRight size={16}/>
      </button>)}
    </div>
    <div className="fp-preview-warning" style={{ marginTop: 18 }}>Each item opens its existing FlowPay page. This hub does not activate providers, move funds or change customer records.</div>
  </section>;
}
