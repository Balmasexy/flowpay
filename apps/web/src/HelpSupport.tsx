import { useMemo, useState } from "react";
import { ArrowRight, BookOpen, CircleHelp, FileText, LockKeyhole, MessageSquareText, Search, ShieldAlert } from "lucide-react";

type Props = { go: (path: string) => void };
type Topic = { title: string; category: string; detail: string; path: string; keywords: string };

const topics: Topic[] = [
  { title: "I cannot sign in", category: "Account access", detail: "Check that you are using the email address registered to your FlowPay account. Use the sign-in recovery option if it is available. Never share your password, one-time code or passkey with anyone claiming to be support.", path: "/login", keywords: "login password account recovery email passkey" },
  { title: "My profile photo or details did not save", category: "Profile", detail: "Open Customer Profile, update the relevant field, and use Save. Reopen the page to confirm the change. If the photo is missing, check that the selected image is accessible and try uploading it again.", path: "/profile", keywords: "photo upload camera profile save picture personal details" },
  { title: "I need to check a transaction", category: "Transactions", detail: "Open Activity to review the transaction history currently available to your account. Money Received and Money Sent show their respective available records. A displayed record is not proof that a pending payment has settled.", path: "/activity", keywords: "transaction history payment debit credit pending failed received sent" },
  { title: "My transfer is not completed", category: "Transfers", detail: "Review Transfers and Money Sent for the status available to your account. The current transfer screen is a preview only; it does not send money or create a bank transfer. Do not retry a payment based only on a preview.", path: "/transfers", keywords: "transfer bank account beneficiary failed send money" },
  { title: "I need help with a card", category: "Cards", detail: "Open Cards to view card records currently linked to your account. Full card details, card creation, PIN changes and freeze controls are not available until a verified card-provider workflow is connected.", path: "/cards", keywords: "debit virtual physical card pin freeze card number" },
  { title: "I have an airtime, data or bill issue", category: "Payments & services", detail: "Open the relevant service page to review the details you entered. The current service pages prepare local previews only; they do not contact a provider, debit your wallet or pay a bill.", path: "/airtime", keywords: "airtime data electricity cable tv bill subscription" },
  { title: "How do I review account security?", category: "Security", detail: "Open Security to review the security information currently available. Do not send passwords, PINs, one-time passcodes, recovery codes or passkey credentials in a support message.", path: "/security", keywords: "security passkey device authentication otp pin password" },
  { title: "Where is my bank account number?", category: "Account details", detail: "Open View Account Number. If a virtual bank account has not been assigned, the page will say so. A wallet ledger account identifier is not a bank account number.", path: "/account-number", keywords: "account number bank nuban virtual account details" },
  { title: "I want to understand savings", category: "Savings", detail: "Savings and Fixed Savings currently provide planning previews only. No funds are deposited, locked, invested or debited by these planners.", path: "/savings", keywords: "savings fixed savings goal interest deposit maturity" }
];

export default function HelpSupport({ go }: Props) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(topics[0].title);
  const [category, setCategory] = useState("Transaction issue");
  const [reference, setReference] = useState("");
  const [details, setDetails] = useState("");
  const [showDraft, setShowDraft] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? topics.filter(t => (t.title + " " + t.category + " " + t.keywords + " " + t.detail).toLowerCase().includes(q)) : topics;
  }, [query]);

  const field: React.CSSProperties = { width: "100%", boxSizing: "border-box", padding: "12px 13px", border: "1px solid var(--fp-border, #d8dee8)", borderRadius: 10, background: "var(--fp-input-bg, transparent)", color: "inherit", font: "inherit" };
  const button: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 8, border: "1px solid var(--fp-border, #d8dee8)", borderRadius: 10, padding: "10px 13px", background: "transparent", color: "inherit", cursor: "pointer", font: "inherit" };

  return <div style={{ display: "grid", gap: 18 }}>
    <section className="fp-panel fp-detail-panel">
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}><span style={{ width: 44, height: 44, borderRadius: 13, display: "grid", placeItems: "center", background: "rgba(255,122,24,.12)", color: "#ff7a18" }}><CircleHelp size={23}/></span><div><h2 style={{ margin: 0 }}>How can we help?</h2><p className="fp-muted" style={{ margin: "5px 0 0" }}>Find guidance for your FlowPay account and services.</p></div></div>
      <div style={{ position: "relative", marginTop: 18 }}><Search size={18} style={{ position: "absolute", left: 13, top: 13, opacity: .6 }}/><input aria-label="Search help topics" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search help topics..." style={{ ...field, paddingLeft: 40 }}/></div>
      <div style={{ display: "grid", gap: 9, marginTop: 16 }}>
        {filtered.map(topic => <div key={topic.title} style={{ border: "1px solid var(--fp-border, #d8dee8)", borderRadius: 12, overflow: "hidden" }}>
          <button type="button" onClick={() => setExpanded(expanded === topic.title ? null : topic.title)} aria-expanded={expanded === topic.title} style={{ ...button, width: "100%", border: 0, borderRadius: 0, justifyContent: "space-between", textAlign: "left", padding: 14 }}>
            <span style={{ display: "flex", gap: 10, alignItems: "center" }}><BookOpen size={17}/><span><b style={{ display: "block" }}>{topic.title}</b><small className="fp-muted">{topic.category}</small></span></span><span>{expanded === topic.title ? "−" : "+"}</span>
          </button>
          {expanded === topic.title && <div style={{ padding: "0 14px 14px" }}><p className="fp-muted" style={{ lineHeight: 1.6, marginTop: 0 }}>{topic.detail}</p><button type="button" style={button} onClick={() => go(topic.path)}>Open related page <ArrowRight size={15}/></button></div>}
        </div>)}
        {filtered.length === 0 && <p className="fp-muted">No matching help topics. Try a different search term.</p>}
      </div>
    </section>

    <section className="fp-panel fp-detail-panel">
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}><MessageSquareText size={20}/><div><h2 style={{ margin: 0 }}>Prepare a support request</h2><p className="fp-muted" style={{ margin: "5px 0 0" }}>Create a copyable draft with the details support may need.</p></div></div>
      <div className="fp-preview-warning" style={{ marginTop: 15 }}><ShieldAlert size={17}/> Support submission is not connected yet. This form does not send or save a request and does not create a ticket.</div>
      <label style={{ display: "grid", gap: 7, marginTop: 16 }}>Issue type<select value={category} onChange={e => { setCategory(e.target.value); setShowDraft(false); setCopyStatus(""); }} style={field}><option>Transaction issue</option><option>Account access</option><option>Profile or photo</option><option>Card issue</option><option>Airtime, data or bill</option><option>Security concern</option><option>Other</option></select></label>
      <label style={{ display: "grid", gap: 7, marginTop: 13 }}>Transaction or reference ID (optional)<input value={reference} onChange={e => { setReference(e.target.value); setShowDraft(false); setCopyStatus(""); }} maxLength={100} placeholder="Enter a reference only if relevant" style={field}/></label>
      <label style={{ display: "grid", gap: 7, marginTop: 13 }}>Describe the issue<textarea value={details} onChange={e => { setDetails(e.target.value); setShowDraft(false); setCopyStatus(""); }} maxLength={2000} rows={5} placeholder="Tell us what happened, when it happened, and what you expected..." style={{ ...field, resize: "vertical" }}/></label>
      <p className="fp-muted" style={{ fontSize: 13, lineHeight: 1.5 }}>Never include your password, PIN, OTP, recovery code, full card number, CVV, BVN or NIN.</p>
      <button type="button" className="fp-primary" disabled={!details.trim()} onClick={() => { setShowDraft(true); setCopyStatus(""); }} style={{ opacity: details.trim() ? 1 : .55 }}>Prepare draft</button>
      {showDraft && <div style={{ marginTop: 14, padding: 14, borderRadius: 12, border: "1px solid var(--fp-border, #d8dee8)" }}>
        <b>Support request draft — not submitted</b>
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", font: "inherit", lineHeight: 1.55, margin: "10px 0" }}>{`Issue type: ${category}\nReference: ${reference.trim() || "Not provided"}\n\nDetails:\n${details.trim()}`}</pre>
        <button type="button" style={button} onClick={async () => {
          const text = `Issue type: ${category}\nReference: ${reference.trim() || "Not provided"}\n\nDetails:\n${details.trim()}`;
          try {
            if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
            await navigator.clipboard.writeText(text);
            setCopyStatus("Draft copied to clipboard.");
          } catch {
            setCopyStatus("Could not access the clipboard. Select and copy the draft text above.");
          }
        }}>Copy draft</button>
        {copyStatus && <small role="status" className="fp-muted" style={{ display: "block", marginTop: 8 }}>{copyStatus}</small>}
        <small className="fp-muted" style={{ display: "block", marginTop: 8 }}>Copy this text and share it only through an official FlowPay support channel when one is provided.</small>
      </div>}
    </section>
    <section className="fp-panel fp-detail-panel"><h2 style={{ display: "flex", gap: 9, alignItems: "center" }}><LockKeyhole size={19}/> Account safety</h2><p className="fp-muted" style={{ lineHeight: 1.6 }}>FlowPay support will never need your password, one-time passcode, card security code or private recovery credentials. If you suspect unauthorized access, review your Security page and use only verified official contact channels.</p><button type="button" style={button} onClick={() => go("/security")}>Review security <ArrowRight size={15}/></button><span style={{ display: "none" }}><FileText/></span></section>
  </div>;
}
