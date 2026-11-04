import { useState } from "react";
import { Check, Copy, Gift, Share2, ShieldCheck } from "lucide-react";

const FLOWPAY_URL = "https://flowpay-web-jx7i.onrender.com/";

export default function InvitationsPage() {
  const [copied, setCopied] = useState(false);
  const inviteText = "Join me on FlowPay to explore convenient account and payment services: " + FLOWPAY_URL;

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(inviteText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  }

  async function shareInvite() {
    if (navigator.share) {
      try { await navigator.share({ title: "FlowPay", text: "Join me on FlowPay", url: FLOWPAY_URL }); }
      catch (error) { if (error instanceof Error && error.name !== "AbortError") await copyInvite(); }
    } else {
      await copyInvite();
    }
  }

  return <section className="fp-panel fp-detail-panel">
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <span style={{ width: 46, height: 46, borderRadius: 13, display: "grid", placeItems: "center", background: "rgba(255,122,24,.12)", color: "#ff7a18" }}><Gift size={23}/></span>
      <div><h2 style={{ margin: 0 }}>Invite people to FlowPay</h2><p className="fp-muted" style={{ margin: "5px 0 0" }}>Share the official FlowPay website with people you know.</p></div>
    </div>
    <div className="fp-preview-warning" style={{ marginTop: 17 }}><ShieldCheck size={17}/> This is a general share link, not a personal referral link. Referral tracking, invite history, codes and rewards are not active.</div>
    <div style={{ marginTop: 18, padding: 15, border: "1px solid var(--fp-border, #d8dee8)", borderRadius: 12 }}>
      <small className="fp-muted">FlowPay website</small>
      <p style={{ overflowWrap: "anywhere", fontWeight: 600 }}>{FLOWPAY_URL}</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        <button type="button" className="fp-primary" onClick={() => void shareInvite()}><Share2 size={17}/> Share invitation</button>
        <button type="button" className="fp-outline" onClick={() => void copyInvite()}>{copied ? <Check size={17}/> : <Copy size={17}/>} {copied ? "Copied" : "Copy invitation"}</button>
      </div>
      {copied && <p role="status" style={{ marginBottom: 0, color: "#16a34a" }}>Invitation copied to clipboard.</p>}
    </div>
    <p className="fp-muted" style={{ marginTop: 15, lineHeight: 1.6 }}>Only share this public website link. Never share your FlowPay login details, account number, one-time passcodes or private account information when inviting someone.</p>
  </section>;
}
