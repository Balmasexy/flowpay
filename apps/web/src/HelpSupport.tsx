import { useEffect, useMemo, useState } from "react";
import { ArrowRight, BookOpen, CircleHelp, FileText, LockKeyhole, MessageSquareText, Search, ShieldAlert } from "lucide-react";

type Props = { go: (path: string) => void; token: string };
type Topic = { title: string; category: string; detail: string; path: string; keywords: string };

const topics: Topic[] = [
  { title: "I cannot sign in", category: "Account access", detail: "Check that you are using the email address registered to your FlowPay account. Use the sign-in recovery option if it is available. Never share your password, one-time code or passkey with anyone claiming to be support.", path: "/login", keywords: "login password account recovery email passkey" },
  { title: "My dashboard balance is showing unavailable", category: "Account balance", detail: "Refresh the dashboard and confirm that you are signed in to the correct FlowPay account. A zero balance is shown only when the authenticated ledger service can verify that no posted ledger entries exist. If posted entries exist but their balance direction has not been verified, FlowPay will withhold the amount rather than display an estimate. Contact support with the time of the issue, but never share a password, PIN or OTP.", path: "/dashboard", keywords: "balance zero 0.0 temporarily unavailable ledger wallet money amount" },
  { title: "My profile photo or details did not save", category: "Profile", detail: "Open Customer Profile, update the relevant field, and use Save. Reopen the page to confirm the change. If the photo is missing, check that the selected image is accessible and try uploading it again.", path: "/profile", keywords: "photo upload camera profile save picture personal details" },
  { title: "I need to check a transaction", category: "Transactions", detail: "Open Activity to review the transaction history currently available to your account. Money Received and Money Sent show their respective available records. A displayed record is not proof that a pending payment has settled.", path: "/activity", keywords: "transaction history payment debit credit pending failed received sent" },
  { title: "My transfer is not completed", category: "Transfers", detail: "Review Transfers and Money Sent for the status available to your account. The current transfer screen is a preview only; it does not send money or create a bank transfer. Do not retry a payment based only on a preview.", path: "/transfers", keywords: "transfer bank account beneficiary failed send money" },
  { title: "I need help with a card", category: "Cards", detail: "Open Cards to view card records currently linked to your account. Full card details, card creation, PIN changes and freeze controls are not available until a verified card-provider workflow is connected. FlowPay never asks you to enter a full card number or CVV into this page.", path: "/cards", keywords: "debit virtual physical card pin freeze card number card issuing" },
  { title: "My virtual card has not been issued", category: "Cards", detail: "Open Cards and refresh to check for an issuer-confirmed card record. A card is not active until a contracted issuer confirms issuance. Do not treat a preview or placeholder as a usable card.", path: "/cards", keywords: "virtual card not connected issuer card missing" },
  { title: "I have an airtime, data or bill issue", category: "Payments & services", detail: "Open the relevant service page to review the details you entered. The current service pages prepare local previews only; they do not contact a provider, debit your wallet or pay a bill.", path: "/airtime", keywords: "airtime data electricity cable tv bill subscription" },
  { title: "How do I review account security?", category: "Security", detail: "Open Security to review the security information currently available. Do not send passwords, PINs, one-time passcodes, recovery codes or passkey credentials in a support message.", path: "/security", keywords: "security passkey device authentication otp pin password" },
  { title: "How do I complete face verification?", category: "Verification", detail: "Open Face Verification and follow the on-screen consent and live-selfie instructions. Verification is complete only when the server records a verified result for your account.", path: "/face-verification", keywords: "face selfie liveness identity verification" },
  { title: "Where is my bank account number?", category: "Account details", detail: "Open View Account Number to copy your 10-digit FlowPay account number for wallet-to-wallet transfers. A provider-issued virtual bank account number is separate and appears only after a verified provider assignment.", path: "/account-number", keywords: "account number bank nuban virtual account details dedicated account" },
  { title: "My virtual account number is not assigned", category: "Account details", detail: "Refresh View Account Number. If the page still says Not yet assigned, the account-number provider has not confirmed an assignment for your customer profile. Do not use a made-up or another customer’s account number.", path: "/account-number", keywords: "virtual account not assigned bank account number" },
  { title: "I need to fund a betting account", category: "Betting", detail: "Open Betting and select your operator, such as SportyBet, Bet9ja or BetKing. The current page prepares a local preview only; it does not validate the betting account or move money.", path: "/betting", keywords: "SportyBet Bet9ja BetKing 1xBet Merrybet NairaBet betting funding" },
  { title: "I want to understand savings", category: "Savings", detail: "Savings and Fixed Savings currently provide planning previews only. No funds are deposited, locked, invested or debited by these planners.", path: "/savings", keywords: "savings fixed savings goal interest deposit maturity" }
];

export default function HelpSupport({ go, token }: Props) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(topics[0].title);
  const [category, setCategory] = useState("Transaction issue");
  const [reference, setReference] = useState("");
  const [details, setDetails] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitStatus, setSubmitStatus] = useState("");
  const [submittedTicket, setSubmittedTicket] = useState("");
  const [requests, setRequests] = useState<Array<{ticketReference:string;category:string;details:string;status:string;createdAt:string}>>([]);
  const [requestsLoading, setRequestsLoading] = useState(true);
  const [requestsError, setRequestsError] = useState("");
  const apiBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") || "";
  const [clientRequestId, setClientRequestId] = useState(() => crypto.randomUUID());

  useEffect(() => {
    let active = true;
    if (!token || !apiBase) { setRequestsLoading(false); setRequestsError("Support service is not configured."); return () => { active = false; }; }
    fetch(apiBase + "/customer/support-requests", { headers: { Authorization: "Bearer " + token }, credentials: "omit" })
      .then(async response => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Unable to load support requests.");
        return data;
      })
      .then(data => { if (active) setRequests(Array.isArray(data.requests) ? data.requests : []); })
      .catch(error => { if (active) setRequestsError(error instanceof Error ? error.message : "Unable to load support requests."); })
      .finally(() => { if (active) setRequestsLoading(false); });
    return () => { active = false; };
  }, [token, apiBase]);

  const submitRequest = async () => {
    if (submitting || details.trim().length < 20 || !token || !apiBase) return;
    setSubmitting(true); setSubmitStatus(""); setSubmittedTicket("");
    try {
      const response = await fetch(apiBase + "/customer/support-requests", {
        method: "POST", credentials: "omit",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ clientRequestId, category, reference: reference.trim() || null, details: details.trim() })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Support request could not be submitted.");
      setSubmittedTicket(data.request?.ticketReference || "");
      setSubmitStatus(data.message || "Your support request was saved.");
      setClientRequestId(crypto.randomUUID());
      setDetails(""); setReference("");
      setRequests(current => [data.request, ...current.filter(item => item.ticketReference !== data.request?.ticketReference)].slice(0, 50));
    } catch (error) {
      setSubmitStatus(error instanceof Error ? error.message : "Support request could not be submitted. Retry safely.");
    } finally { setSubmitting(false); }
  };
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? topics.filter(t => (t.title + " " + t.category + " " + t.keywords + " " + t.detail).toLowerCase().includes(q)) : topics;
  }, [query]);

  const field: React.CSSProperties = { width: "100%", boxSizing: "border-box", padding: "12px 13px", border: "1px solid var(--fp-border, #d8dee8)", borderRadius: 10, background: "var(--fp-input-bg, transparent)", color: "inherit", font: "inherit" };
  const button: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 8, border: "1px solid var(--fp-border, #d8dee8)", borderRadius: 10, padding: "10px 13px", background: "transparent", color: "inherit", cursor: "pointer", font: "inherit" };

  return <div style={{ display: "grid", gap: 18 }}>
    <section className="fp-panel fp-detail-panel">
      <div style={{ display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}><div style={{display:"flex",gap:12,alignItems:"center"}}><span style={{ width: 44, height: 44, borderRadius: 13, display: "grid", placeItems: "center", background: "rgba(255,122,24,.12)", color: "#ff7a18" }}><CircleHelp size={23}/></span><div><h2 style={{ margin: 0 }}>How can we help?</h2><p className="fp-muted" style={{ margin: "5px 0 0" }}>Find guidance for your FlowPay account and services.</p></div></div><button type="button" style={button} onClick={()=>go("/search")}><Search size={15}/> Back to Search</button></div>
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
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}><MessageSquareText size={20}/><div><h2 style={{ margin: 0 }}>Submit a support request</h2><p className="fp-muted" style={{ margin: "5px 0 0" }}>Your request is saved securely against your signed-in FlowPay account.</p></div></div>
      <div className="fp-preview-warning" style={{ marginTop: 15 }}><ShieldAlert size={17}/> Never include passwords, PINs, OTPs, recovery codes, full card numbers, CVV, BVN or NIN.</div>
      <label style={{ display: "grid", gap: 7, marginTop: 16 }}>Issue type<select value={category} onChange={e => { setCategory(e.target.value); setSubmitStatus(""); setSubmittedTicket(""); }} style={field}><option>Transaction issue</option><option>Account access</option><option>Profile or photo</option><option>Card issue</option><option>Airtime, data or bill</option><option>Security concern</option><option>Other</option></select></label>
      <label style={{ display: "grid", gap: 7, marginTop: 13 }}>Transaction or reference ID (optional)<input value={reference} onChange={e => { setReference(e.target.value); setSubmitStatus(""); }} maxLength={100} placeholder="Enter a reference only if relevant" style={field}/></label>
      <label style={{ display: "grid", gap: 7, marginTop: 13 }}>Describe the issue<textarea value={details} onChange={e => { setDetails(e.target.value); setSubmitStatus(""); }} maxLength={2000} minLength={20} rows={5} placeholder="Tell us what happened, when it happened, and what you expected (at least 20 characters)..." style={{ ...field, resize: "vertical" }}/></label>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginTop: 14 }}>
        <button type="button" className="fp-primary" disabled={submitting || !token || details.trim().length < 20} onClick={submitRequest} style={{ opacity: submitting || !token || details.trim().length < 20 ? .55 : 1 }}>{submitting ? "Submitting…" : "Submit support request"}</button>
        <small className="fp-muted">{details.trim().length}/2000 characters</small>
      </div>
      {submitStatus && <p role="status" className="fp-muted" style={{ marginTop: 12 }}>{submitStatus}</p>}
      {submittedTicket && <div style={{ marginTop: 12, padding: 14, borderRadius: 12, border: "1px solid var(--fp-border, #d8dee8)" }}>
        <b>Request submitted successfully</b><p style={{ margin: "7px 0" }}>Ticket reference: <strong>{submittedTicket}</strong></p><small className="fp-muted">Save this reference for follow-up. Your request is recorded as open; a support agent response is not implied by submission.</small>
      </div>}
      <div style={{ marginTop: 22 }}>
        <h3 style={{ margin: "0 0 10px" }}>Your support requests</h3>
        {requestsLoading ? <p className="fp-muted">Loading your requests…</p> : requestsError ? <p className="fp-muted">{requestsError}</p> : requests.length === 0 ? <p className="fp-muted">You have no submitted support requests yet.</p> : <div style={{ display: "grid", gap: 9 }}>
          {requests.map(item => <div key={item.ticketReference} style={{ border: "1px solid var(--fp-border, #d8dee8)", borderRadius: 10, padding: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}><b>{item.ticketReference}</b><small className="fp-muted">{item.status.replace("_", " ")}</small></div>
            <div style={{ marginTop: 5 }}>{item.category}</div>
            <small className="fp-muted">{new Date(item.createdAt).toLocaleString()}</small>
            <p className="fp-muted" style={{ margin: "7px 0 0", whiteSpace: "pre-wrap" }}>{item.details}</p>
          </div>)}
        </div>}
      </div>
    </section>
    <section className="fp-panel fp-detail-panel"><h2 style={{ display: "flex", gap: 9, alignItems: "center" }}><LockKeyhole size={19}/> Account safety</h2><p className="fp-muted" style={{ lineHeight: 1.6 }}>FlowPay support will never need your password, one-time passcode, card security code or private recovery credentials. If you suspect unauthorized access, review your Security page and use only verified official contact channels.</p><button type="button" style={button} onClick={() => go("/security")}>Review security <ArrowRight size={15}/></button><span style={{ display: "none" }}><FileText/></span></section>
  </div>;
}
