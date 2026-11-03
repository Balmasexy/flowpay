import { ArrowRight, ShieldCheck, Wallet, CreditCard, Smartphone, LockKeyhole, Activity } from "lucide-react";

const features = [
  { icon: Wallet, title: "One clear money view", text: "See your available balance and account activity when securely connected." },
  { icon: ArrowRight, title: "Move money with confidence", text: "A simpler path to transfers, with verification and ledger controls at the core." },
  { icon: CreditCard, title: "Cards and account tools", text: "Manage card services, account details and security from one place." },
  { icon: Smartphone, title: "Everyday services", text: "Airtime, data and bill-payment journeys designed for everyday use." },
];

export default function LandingPage() {
  return <main className="fp-landing">
    <header className="fp-public-header">
      <a className="fp-public-brand" href="/"><span className="fp-public-logo">F</span>Flow<span>Pay</span></a>
      <nav><a href="#features">Features</a><a href="#security">Security</a><a className="fp-public-login" href="/login">Log in <ArrowRight size={15}/></a></nav>
    </header>
    <section className="fp-hero">
      <div className="fp-hero-copy">
        <div className="fp-public-kicker"><span/> DIGITAL FINANCE, MADE CLEAR</div>
        <h1>Your money.<br/><em>Your move.</em></h1>
        <p>Manage your money and everyday financial services in one thoughtful place. FlowPay is built around clarity, security and control.</p>
        <div className="fp-hero-actions"><a className="fp-cta" href="/login">Access your account <ArrowRight size={17}/></a><a className="fp-text-link" href="#features">Explore FlowPay</a></div>
        <div className="fp-trust-line"><ShieldCheck size={16}/> Secure access · Verified activity · Clear account controls</div>
      </div>
      <div className="fp-hero-art" aria-label="FlowPay account preview">
        <div className="fp-orbit fp-orbit-one"/><div className="fp-orbit fp-orbit-two"/>
        <div className="fp-preview-card"><div className="fp-preview-top"><span className="fp-preview-mark">F</span><span>FLOWPAY ACCOUNT</span><LockKeyhole size={16}/></div><small>AVAILABLE BALANCE</small><strong>₦ — —</strong><div className="fp-preview-divider"/><div className="fp-preview-bottom"><span>Account overview</span><span>•••• ••••</span></div></div>
        <div className="fp-float-chip"><Activity size={17}/><span><b>Account activity</b><small>Clear and trackable</small></span></div>
        <div className="fp-float-chip fp-float-chip-two"><ShieldCheck size={18}/><span><b>Security first</b><small>Protected access</small></span></div>
      </div>
    </section>
    <section className="fp-public-strip"><div><b>Built for everyday finance</b><span>Useful tools, presented simply.</span></div><div><b>Designed around trust</b><span>No invented balances or activity.</span></div><div><b>Security-led access</b><span>Account access requires verification.</span></div></section>
    <section className="fp-public-features" id="features"><div className="fp-public-section-head"><span>THE FLOWPAY EXPERIENCE</span><h2>Everything important,<br/>within reach.</h2><p>A connected experience for the financial tasks that matter.</p></div><div className="fp-public-feature-grid">{features.map(({icon:Icon,title,text})=><article key={title}><span className="fp-public-feature-icon"><Icon size={21}/></span><h3>{title}</h3><p>{text}</p></article>)}</div></section>
    <section className="fp-public-security" id="security"><div><span>SECURITY IS FOUNDATIONAL</span><h2>Your account stays<br/>under your control.</h2><p>FlowPay is designed to rely on verified identity, authenticated sessions and auditable account activity. Services remain unavailable until their secure integrations are ready.</p><a href="/login">Continue to login <ArrowRight size={16}/></a></div><div className="fp-security-mark"><ShieldCheck size={72}/><b>Security-led<br/>by design</b><small>Verified access. Clear controls.</small></div></section>
    <footer className="fp-public-footer"><a className="fp-public-brand" href="/"><span className="fp-public-logo">F</span>Flow<span>Pay</span></a><span>© {new Date().getFullYear()} FlowPay. All rights reserved.</span><a href="/login">Account login</a></footer>
  </main>;
}