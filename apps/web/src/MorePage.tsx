import { ArrowRight, FileText, Gift, HelpCircle, LockKeyhole, ShieldCheck, Smartphone, Wallet, Zap } from "lucide-react";

type Props = { go: (path: string) => void };

const items = [
  { title: "Customer profile", description: "Review your personal details and profile photo.", path: "/profile", icon: Smartphone },
  { title: "Account number", description: "Check your virtual bank-account assignment status.", path: "/account-number", icon: Wallet },
  { title: "Documents & statements", description: "Review available document and statement options.", path: "/documents", icon: FileText },
  { title: "Security centre", description: "Review available sign-in and account-security information.", path: "/security", icon: LockKeyhole },
  { title: "Face & liveness verification", description: "Smile ID sandbox verification requires configured API credentials and callback setup.", path: "/face-verification", icon: ShieldCheck },
  { title: "Bulk payments", description: "Submit reviewed bank-payment rows individually. Paystack transfer approval and configuration are required.", path: "/bulk-payments", icon: Zap },
  { title: "Bulk verification", description: "Verify Nigerian bank account numbers and compare provider-returned account names. This is not KYC.", path: "/bulk-verification", icon: ShieldCheck },
  { title: "Invitations", description: "Referral invitations are not yet connected to an active referral service.", path: "/invitations", icon: Gift },
  { title: "Help & support", description: "Search help topics and prepare a support-request draft.", path: "/support", icon: HelpCircle }
];

export default function MorePage({ go }: Props) {
  return <section className="fp-panel fp-detail-panel">
    <h2>More FlowPay services</h2>
    <p className="fp-muted">Open additional account tools and service sections from one place.</p>
    <div className="fp-more-grid">
      {items.map(({ title, description, path, icon: Icon }) => <button className="fp-more-item" key={path} type="button" onClick={() => go(path)}>
        <span className="fp-more-icon"><Icon size={19}/></span>
        <span className="fp-more-copy"><b>{title}</b><small>{description}</small></span>
        <ArrowRight className="fp-more-arrow" size={16}/>
      </button>)}
    </div>
    <div className="fp-preview-warning" style={{ marginTop: 18 }}>Each item opens its existing FlowPay page. This hub does not activate providers, move funds or change customer records.</div>
  </section>;
}
