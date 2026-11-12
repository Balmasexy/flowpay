import { useEffect, useState } from "react";
import {
  ShieldCheck, Users, Wallet, ArrowLeftRight, CreditCard, SlidersHorizontal,
  FileText, Settings, LockKeyhole, Activity, FileCheck2, RefreshCw,
  ExternalLink, CheckCircle2, XCircle, AlertCircle, Clock3
} from "lucide-react";

type VirtualBankAccount = {
  assigned: boolean;
  status: string;
  accountNumber: string | null;
  bankName: string | null;
  accountName: string | null;
};

type ReceiptQueueItem = {
  id: string;
  customerId: string;
  customerEmail: string | null;
  amountMinor: string;
  currency: string;
  reference: string | null;
  note: string | null;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  status: "pending_upload" | "pending_review";
  createdAt: string;
  fileUrl: string | null;
};

const sections = [
  { label: "Overview", icon: Activity },
  { label: "Customers", icon: Users },
  { label: "Accounts & wallets", icon: Wallet },
  { label: "Super Admin virtual account", icon: Wallet },
  { label: "Transactions", icon: ArrowLeftRight },
  { label: "Deposit receipts", icon: FileCheck2 },
  { label: "Cards", icon: CreditCard },
  { label: "Staff & roles", icon: LockKeyhole },
  { label: "Provider controls", icon: SlidersHorizontal },
  { label: "Audit logs", icon: FileText },
  { label: "System settings", icon: Settings },
];

function amountLabel(amountMinor: string, currency: string) {
  const amount = Number(amountMinor) / 100;
  if (!Number.isFinite(amount)) return "Amount unavailable";
  try {
    return new Intl.NumberFormat("en-NG", { style: "currency", currency }).format(amount);
  } catch {
    return currency + " " + amount.toFixed(2);
  }
}
function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleString();
}

export default function AdminPage({ token }: { token: string }) {
  const [access, setAccess] = useState<"checking" | "authorized" | "denied" | "error">("checking");
  const [receipts, setReceipts] = useState<ReceiptQueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [bankReferences, setBankReferences] = useState<Record<string, string>>({});
  const [fundsConfirmed, setFundsConfirmed] = useState<Record<string, boolean>>({});
  const [busyId, setBusyId] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [actionError, setActionError] = useState("");
  const [virtualAccount, setVirtualAccount] = useState<VirtualBankAccount | null>(null);
  const [virtualAccountConsent, setVirtualAccountConsent] = useState(false);
  const [virtualAccountBusy, setVirtualAccountBusy] = useState(false);
  const [virtualAccountMessage, setVirtualAccountMessage] = useState("");
  const [virtualAccountError, setVirtualAccountError] = useState("");
  const apiBase = String(import.meta.env.VITE_API_BASE_URL || "").replace(/\/+$/, "");

  useEffect(() => {
    let active = true;
    const load = async () => {
      if (!token || !apiBase) {
        setAccess("error"); setLoadError("A secure FlowPay API session is required."); setLoading(false); return;
      }
      setLoading(true); setLoadError("");
      try {
        const authResponse = await fetch(apiBase + "/admin/session", {
          method: "GET", credentials: "omit", headers: { Authorization: "Bearer " + token }
        });
        const authData: unknown = await authResponse.json().catch(() => ({}));
        if (!authResponse.ok) {
          if (active) {
            setAccess(authResponse.status === 401 || authResponse.status === 403 ? "denied" : "error");
            setLoadError("This account is not authorised for FlowPay Super Admin access.");
          }
          return;
        }
        const authRoot = authData && typeof authData === "object" ? authData as Record<string, unknown> : {};
        if (authRoot.authorized !== true || authRoot.role !== "super_admin") {
          if (active) { setAccess("denied"); setLoadError("This account is not authorised for FlowPay Super Admin access."); }
          return;
        }
        const virtualResponse = await fetch(apiBase + "/customer/dedicated-bank-account", {
          method: "GET", credentials: "omit", headers: { Authorization: "Bearer " + token }
        });
        const virtualData: unknown = await virtualResponse.json().catch(() => ({}));
        const virtualRoot = virtualData && typeof virtualData === "object" ? virtualData as Record<string, unknown> : {};
        const virtualRaw = virtualRoot.virtualBankAccount && typeof virtualRoot.virtualBankAccount === "object"
          ? virtualRoot.virtualBankAccount as Record<string, unknown> : null;
        if (active && virtualResponse.ok && virtualRaw && typeof virtualRaw.assigned === "boolean") {
          setVirtualAccount({
            assigned: virtualRaw.assigned,
            status: typeof virtualRaw.status === "string" ? virtualRaw.status : "unknown",
            accountNumber: typeof virtualRaw.accountNumber === "string" ? virtualRaw.accountNumber : null,
            bankName: typeof virtualRaw.bankName === "string" ? virtualRaw.bankName : null,
            accountName: typeof virtualRaw.accountName === "string" ? virtualRaw.accountName : null
          });
        } else if (active && !virtualResponse.ok) {
          setVirtualAccountError("Virtual bank account status is unavailable. Refresh to retry.");
        }
        const queueResponse = await fetch(apiBase + "/admin/deposit-receipts", {
          method: "GET", credentials: "omit", headers: { Authorization: "Bearer " + token }
        });
        const queueData: unknown = await queueResponse.json().catch(() => ({}));
        if (!queueResponse.ok) {
          const root = queueData && typeof queueData === "object" ? queueData as Record<string, unknown> : {};
          throw new Error(typeof root.message === "string" ? root.message : typeof root.error === "string" ? root.error : "Receipt review queue is unavailable.");
        }
        const root = queueData && typeof queueData === "object" ? queueData as Record<string, unknown> : {};
        const values = Array.isArray(root.receipts) ? root.receipts : [];
        const parsed = values.filter((item): item is ReceiptQueueItem => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return false;
          const row = item as Record<string, unknown>;
          return typeof row.id === "string" && typeof row.amountMinor === "string" &&
            (row.status === "pending_upload" || row.status === "pending_review");
        }).map(item => item as ReceiptQueueItem);
        if (active) { setAccess("authorized"); setReceipts(parsed); }
      } catch (error) {
        if (active) { setAccess("error"); setLoadError(error instanceof Error ? error.message : "Unable to load the receipt queue."); }
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => { active = false; };
  }, [token, apiBase, refresh]);

  const requestVirtualAccount = async () => {
    if (!virtualAccountConsent || virtualAccountBusy) return;
    setVirtualAccountBusy(true);
    setVirtualAccountError("");
    setVirtualAccountMessage("");
    try {
      const response = await fetch(apiBase + "/customer/dedicated-bank-account", {
        method: "POST",
        credentials: "omit",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ consent: true })
      });
      const payload: unknown = await response.json().catch(() => ({}));
      const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
      const raw = root.virtualBankAccount && typeof root.virtualBankAccount === "object"
        ? root.virtualBankAccount as Record<string, unknown> : null;
      if (raw && typeof raw.assigned === "boolean") {
        setVirtualAccount({
          assigned: raw.assigned,
          status: typeof raw.status === "string" ? raw.status : "unknown",
          accountNumber: typeof raw.accountNumber === "string" ? raw.accountNumber : null,
          bankName: typeof raw.bankName === "string" ? raw.bankName : null,
          accountName: typeof raw.accountName === "string" ? raw.accountName : null
        });
      }
      if (!response.ok) {
        const detail = typeof root.message === "string" ? root.message : typeof root.error === "string" ? root.error : "Paystack did not assign a virtual bank account.";
        throw new Error(detail);
      }
      setVirtualAccountMessage(typeof root.message === "string"
        ? root.message
        : raw?.assigned === true
          ? "Paystack confirmed the Super Admin virtual bank account."
          : "The request was accepted. The account number will appear only after provider confirmation.");
    } catch (error) {
      setVirtualAccountError(error instanceof Error ? error.message : "Virtual bank account request failed.");
    } finally {
      setVirtualAccountBusy(false);
      setRefresh(value => value + 1);
    }
  };

  const review = async (item: ReceiptQueueItem, decision: "approve" | "reject") => {
    const reviewNote = (notes[item.id] ?? "").trim();
    const bankTransactionReference = (bankReferences[item.id] ?? "").trim();
    if (reviewNote.length < 10 || reviewNote.length > 500) {
      setActionError("Enter a reviewer note between 10 and 500 characters."); return;
    }
    if (decision === "approve" && (!fundsConfirmed[item.id] || bankTransactionReference.length < 5 || bankTransactionReference.length > 100)) {
      setActionError("Confirm the funds are in the bank statement and enter the bank transaction reference before approving."); return;
    }
    setBusyId(item.id); setActionError(""); setActionMessage("");
    try {
      const response = await fetch(apiBase + "/admin/deposit-receipts/" + encodeURIComponent(item.id) + "/review", {
        method: "POST", credentials: "omit",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({
          decision, reviewNote,
          bankTransactionReference: decision === "approve" ? bankTransactionReference : undefined,
          fundsVerified: decision === "approve"
        })
      });
      const data: unknown = await response.json().catch(() => ({}));
      const root = data && typeof data === "object" ? data as Record<string, unknown> : {};
      if (!response.ok) throw new Error(typeof root.message === "string" ? root.message : typeof root.error === "string" ? root.error : "The review decision could not be saved.");
      setActionMessage(decision === "approve"
        ? "Receipt approved. The balanced wallet credit was posted."
        : "Receipt rejected. No wallet credit was posted.");
      setRefresh(value => value + 1);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The receipt review failed.");
    } finally { setBusyId(""); }
  };

  return (
    <div className="fp-admin">
      <aside className="fp-admin-sidebar">
        <div className="fp-admin-brand"><span className="fp-admin-logo">F</span><span>FlowPay <small>ADMINISTRATION</small></span></div>
        <div className="fp-admin-nav-label">WORKSPACE</div>
        <nav aria-label="Super Admin navigation">
          {sections.map(({ label, icon: Icon }) => (
            <div className={label === "Deposit receipts" ? "fp-admin-nav-item active" : "fp-admin-nav-item"} key={label}>
              <Icon size={17}/><span>{label}</span>
            </div>
          ))}
        </nav>
        <div className="fp-admin-sidebar-foot"><ShieldCheck size={16}/> Restricted administrator area</div>
      </aside>
      <main className="fp-admin-main">
        <header className="fp-admin-topbar"><span>FlowPay / Super Admin / Deposit receipts</span><span className="fp-admin-env">PRIVATE REVIEW QUEUE</span></header>
        <section className="fp-admin-heading">
          <div><div className="fp-admin-eyebrow">MANUAL DEPOSIT REVIEW</div><h1>Deposit receipts</h1><p>Inspect private receipt files and verify settlement before any wallet credit is posted.</p></div>
          <button type="button" className="fp-admin-refresh" onClick={() => setRefresh(value => value + 1)} disabled={loading}><RefreshCw size={15}/> Refresh queue</button>
        </section>

        {access === "checking" || loading ? <section className="fp-admin-lock"><Clock3 size={22}/><b>Checking administrator access and loading receipts…</b></section>
          : access === "denied" ? <section className="fp-admin-lock"><LockKeyhole size={25}/><div><h2>Super Admin access required</h2><p>{loadError}</p></div></section>
          : access === "error" ? <section className="fp-admin-lock"><AlertCircle size={25}/><div><h2>Review queue unavailable</h2><p>{loadError}</p></div></section>
          : <>
            <section className="fp-admin-review-guidance" aria-labelledby="fp-admin-dva-title">
              <Wallet size={18}/>
              <div style={{ flex: 1 }}>
                <h2 id="fp-admin-dva-title" style={{ margin: "0 0 6px" }}>Super Admin virtual bank account</h2>
                {virtualAccount?.assigned && virtualAccount.accountNumber && virtualAccount.bankName && virtualAccount.accountName
                  ? <div className="fp-admin-receipt-details">
                      <div><span>Account number</span><b>{virtualAccount.accountNumber}</b></div>
                      <div><span>Bank</span><b>{virtualAccount.bankName}</b></div>
                      <div><span>Account name</span><b>{virtualAccount.accountName}</b></div>
                    </div>
                  : <p style={{ margin: 0 }}>Status: <b>{virtualAccount?.status ?? "not confirmed"}</b>. No bank account number is shown until Paystack confirms assignment.</p>}
                {virtualAccountMessage && <p role="status">{virtualAccountMessage}</p>}
                {virtualAccountError && <p role="alert">{virtualAccountError}</p>}
                <label className="fp-admin-confirm" style={{ marginTop: 10 }}>
                  <input type="checkbox" checked={virtualAccountConsent} onChange={event => setVirtualAccountConsent(event.target.checked)} disabled={virtualAccountBusy || virtualAccount?.assigned === true}/>
                  I consent to FlowPay sending my registered full name, email address and phone number to Paystack to request this account.
                </label>
                <button type="button" className="fp-admin-refresh" onClick={() => void requestVirtualAccount()} disabled={!virtualAccountConsent || virtualAccountBusy || virtualAccount?.assigned === true} style={{ marginTop: 10 }}>
                  {virtualAccountBusy ? "Requesting account…" : "Request Super Admin virtual account"}
                </button>
                <p style={{ margin: "8px 0 0", fontSize: 12 }}>Availability depends on Paystack live-mode eligibility and required customer identity validation. The existing API may reject requests until provider access is enabled.</p>
              </div>
            </section>
            {actionMessage && <div className="fp-admin-feedback success"><CheckCircle2 size={17}/>{actionMessage}</div>}
            {actionError && <div className="fp-admin-feedback error"><AlertCircle size={17}/>{actionError}</div>}
            <div className="fp-admin-review-guidance">
              <ShieldCheck size={18}/>
              <p><b>Approval rule:</b> open the receipt, match the exact amount and reference against the bank statement or provider settlement records, and approve only after the funds are visible in FlowPay’s receiving account. A receipt image alone is not settlement evidence.</p>
            </div>
            {receipts.length === 0 ? <section className="fp-admin-empty"><FileCheck2 size={26}/><b>No receipts awaiting review</b><span>New customer submissions will appear here after their files have been uploaded and validated.</span></section>
              : <div className="fp-admin-receipt-list">{receipts.map(item => <article className="fp-admin-receipt-card" key={item.id}>
                <div className="fp-admin-receipt-top">
                  <div><span className="fp-admin-receipt-status">{item.status === "pending_review" ? "AWAITING REVIEW" : "UPLOAD INCOMPLETE"}</span><h2>{amountLabel(item.amountMinor, item.currency)}</h2><p>{item.customerEmail || item.customerId}</p></div>
                  <small>{dateLabel(item.createdAt)}</small>
                </div>
                <div className="fp-admin-receipt-details">
                  <div><span>Customer reference</span><b>{item.reference || "Not supplied"}</b></div>
                  <div><span>File</span><b>{item.fileName} · {(item.sizeBytes / 1024 / 1024).toFixed(2)} MB</b></div>
                  <div><span>Customer note</span><b>{item.note || "No additional details"}</b></div>
                </div>
                {item.fileUrl && <a className="fp-admin-receipt-file" href={item.fileUrl} target="_blank" rel="noreferrer"><ExternalLink size={15}/> Open private receipt</a>}
                {item.status === "pending_review" && <>
                  <label htmlFor={"receipt-note-" + item.id}>Reviewer note</label>
                  <textarea id={"receipt-note-" + item.id} value={notes[item.id] ?? ""} onChange={event => setNotes(current => ({ ...current, [item.id]: event.target.value }))} rows={2} maxLength={500} placeholder="Record the verification or rejection reason." disabled={busyId === item.id}/>
                  <label htmlFor={"receipt-bank-ref-" + item.id}>Bank transaction reference (required for approval)</label>
                  <input id={"receipt-bank-ref-" + item.id} value={bankReferences[item.id] ?? ""} onChange={event => setBankReferences(current => ({ ...current, [item.id]: event.target.value }))} maxLength={100} placeholder="Reference from your bank statement" disabled={busyId === item.id}/>
                  <label className="fp-admin-confirm"><input type="checkbox" checked={fundsConfirmed[item.id] === true} onChange={event => setFundsConfirmed(current => ({ ...current, [item.id]: event.target.checked }))} disabled={busyId === item.id}/> I independently confirmed the exact amount has reached FlowPay’s receiving bank account.</label>
                  <div className="fp-admin-receipt-actions">
                    <button type="button" onClick={() => void review(item, "approve")} disabled={busyId === item.id || !fundsConfirmed[item.id]}><CheckCircle2 size={15}/>{busyId === item.id ? "Saving…" : "Verify & credit wallet"}</button>
                    <button type="button" className="reject" onClick={() => void review(item, "reject")} disabled={busyId === item.id}><XCircle size={15}/>Reject receipt</button>
                  </div>
                </>}
              </article>)}</div>}
          </>}
        <footer className="fp-admin-footer">© {new Date().getFullYear()} FlowPay · Administrative access is monitored and audited.</footer>
      </main>
    </div>
  );
}
