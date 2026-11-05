import { useCallback, useEffect, useState } from "react";
import {
  Activity, AlertCircle, FileImage, FileText, LockKeyhole,
  RefreshCw, ShieldCheck, Users, Wallet, ArrowLeftRight, CreditCard, SlidersHorizontal,
  Settings, X, Eye, Check, XCircle
} from "lucide-react";

type Receipt = {
  id: string;
  transactionId: string;
  customerId: string;
  customerName: string;
  customerEmail: string;
  reference: string;
  amountMinor: string;
  currency: string;
  depositStatus: "pending" | "posted" | "failed";
  fileName: string;
  mimeType: string;
  fileSize: number;
  reviewStatus: "pending_review" | "evidence_accepted" | "rejected";
  reviewNote: string | null;
  createdAt: string;
  reviewedAt: string | null;
};
type Filter = "pending_review" | "evidence_accepted" | "rejected" | "all";

const sections = [
  { label: "Overview", icon: Activity },
  { label: "Customers", icon: Users },
  { label: "Accounts & wallets", icon: Wallet },
  { label: "Transactions", icon: ArrowLeftRight },
  { label: "Cards", icon: CreditCard },
  { label: "Provider controls", icon: SlidersHorizontal },
  { label: "Audit logs", icon: FileText },
  { label: "System settings", icon: Settings }
];
const filters: { value: Filter; label: string }[] = [
  { value: "pending_review", label: "Awaiting review" },
  { value: "evidence_accepted", label: "Evidence accepted" },
  { value: "rejected", label: "Rejected" },
  { value: "all", label: "All submissions" }
];

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function money(minor: string, currency: string) {
  const amount = Number(minor) / 100;
  try { return new Intl.NumberFormat("en-NG", { style: "currency", currency }).format(amount); }
  catch { return currency + " " + amount.toFixed(2); }
}
function date(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Date unavailable" : parsed.toLocaleString();
}
function errorText(data: unknown, fallback: string) {
  const body = record(data);
  return typeof body.message === "string" ? body.message
    : typeof body.error === "string" ? body.error.replaceAll("_", " ").toLowerCase()
    : fallback;
}

export default function AdminPage({ token }: { token: string }) {
  const apiBase = String(import.meta.env.VITE_API_BASE_URL || "").replace(/\/+$/, "");
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [role, setRole] = useState("");
  const [authError, setAuthError] = useState("");
  const [items, setItems] = useState<Receipt[]>([]);
  const [filter, setFilter] = useState<Filter>("pending_review");
  const [loading, setLoading] = useState(false);
  const [pageError, setPageError] = useState("");
  const [reviewBusy, setReviewBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<{ url: string; name: string } | null>(null);
  const [previewBusy, setPreviewBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token || !apiBase) {
      setAuthorized(false);
      setAuthError("A valid FlowPay administrator session is required.");
      return;
    }
    setLoading(true);
    setPageError("");
    try {
      const sessionResponse = await fetch(apiBase + "/admin/session", {
        method: "GET",
        credentials: "omit",
        headers: { Authorization: "Bearer " + token }
      });
      const sessionBody = record(await sessionResponse.json().catch(() => ({})));
      if (!sessionResponse.ok || sessionBody.authenticated !== true || sessionBody.authorized !== true) {
        setAuthorized(false);
        setAuthError(errorText(sessionBody, "This account does not have FlowPay administrator access."));
        setItems([]);
        return;
      }
      setAuthorized(true);
      setRole(typeof sessionBody.role === "string" ? sessionBody.role : "administrator");
      const response = await fetch(apiBase + "/admin/deposit-receipts?status=" + encodeURIComponent(filter), {
        method: "GET",
        credentials: "omit",
        headers: { Authorization: "Bearer " + token }
      });
      const body = record(await response.json().catch(() => ({})));
      if (!response.ok) throw new Error(errorText(body, "Unable to load deposit receipt submissions."));
      const rows = Array.isArray(body.receipts) ? body.receipts : [];
      const parsed = rows.flatMap((value): Receipt[] => {
        const row = record(value);
        if (typeof row.id !== "string" || typeof row.reference !== "string" ||
            typeof row.fileName !== "string" || typeof row.mimeType !== "string" ||
            typeof row.amountMinor !== "string" || typeof row.currency !== "string" ||
            !["pending", "posted", "failed"].includes(String(row.depositStatus)) ||
            !["pending_review", "evidence_accepted", "rejected"].includes(String(row.reviewStatus))) return [];
        return [{
          id: row.id,
          transactionId: typeof row.transactionId === "string" ? row.transactionId : "",
          customerId: typeof row.customerId === "string" ? row.customerId : "",
          customerName: typeof row.customerName === "string" ? row.customerName : "FlowPay customer",
          customerEmail: typeof row.customerEmail === "string" ? row.customerEmail : "",
          reference: row.reference,
          amountMinor: row.amountMinor,
          currency: row.currency,
          depositStatus: row.depositStatus as Receipt["depositStatus"],
          fileName: row.fileName,
          mimeType: row.mimeType,
          fileSize: typeof row.fileSize === "number" ? row.fileSize : 0,
          reviewStatus: row.reviewStatus as Receipt["reviewStatus"],
          reviewNote: typeof row.reviewNote === "string" ? row.reviewNote : null,
          createdAt: typeof row.createdAt === "string" ? row.createdAt : "",
          reviewedAt: typeof row.reviewedAt === "string" ? row.reviewedAt : null
        }];
      });
      setItems(parsed);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Unable to load administrator records.");
    } finally {
      setLoading(false);
    }
  }, [apiBase, token, filter]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => { if (preview?.url) URL.revokeObjectURL(preview.url); }, [preview?.url]);

  const openReceipt = async (item: Receipt) => {
    setPreviewBusy(item.id);
    setPageError("");
    try {
      const response = await fetch(apiBase + "/admin/deposit-receipts/" + encodeURIComponent(item.id) + "/file", {
        method: "GET",
        credentials: "omit",
        headers: { Authorization: "Bearer " + token }
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(errorText(body, "The private receipt image could not be loaded."));
      }
      const blob = await response.blob();
      if (!["image/jpeg", "image/png", "image/webp"].includes(blob.type)) {
        throw new Error("The receipt image type is not permitted.");
      }
      const url = URL.createObjectURL(blob);
      setPreview({ url, name: item.fileName });
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Unable to open receipt image.");
    } finally {
      setPreviewBusy(null);
    }
  };

  const review = async (item: Receipt, reviewStatus: "evidence_accepted" | "rejected") => {
    if (reviewBusy) return;
    const reviewNote = (notes[item.id] ?? "").trim();
    if (reviewStatus === "rejected" && reviewNote.length < 3) {
      setPageError("Enter a reason of at least three characters before rejecting a receipt.");
      return;
    }
    setReviewBusy(item.id);
    setPageError("");
    try {
      const response = await fetch(apiBase + "/admin/deposit-receipts/" + encodeURIComponent(item.id) + "/review", {
        method: "PATCH",
        credentials: "omit",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ reviewStatus, reviewNote })
      });
      const body = record(await response.json().catch(() => ({})));
      if (!response.ok) throw new Error(errorText(body, "Receipt review could not be saved."));
      setItems(current => current.map(row => row.id === item.id ? {
        ...row, reviewStatus, reviewNote: reviewNote || null, reviewedAt: new Date().toISOString()
      } : row));
      await load();
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Receipt review could not be saved.");
    } finally {
      setReviewBusy(null);
    }
  };

  return <div className="fp-admin fp-admin-receipts">
    <aside className="fp-admin-sidebar">
      <div className="fp-admin-brand"><span className="fp-admin-logo">F</span><span>FlowPay <small>ADMINISTRATION</small></span></div>
      <div className="fp-admin-nav-label">WORKSPACE</div>
      <nav aria-label="Super Admin navigation">
        {sections.map(({ label, icon: Icon }) => <div className={label === "Transactions" ? "fp-admin-nav-item active" : "fp-admin-nav-item"} key={label}><Icon size={17}/><span>{label}</span></div>)}
        <div className="fp-admin-nav-item active"><FileImage size={17}/><span>Deposit receipts</span></div>
      </nav>
      <div className="fp-admin-sidebar-foot"><ShieldCheck size={16}/> Restricted administrator area</div>
    </aside>
    <main className="fp-admin-main">
      <header className="fp-admin-topbar"><span>FlowPay / Super Admin / Deposit receipts</span><span className="fp-admin-env">{authorized ? role.toUpperCase().replaceAll("_", " ") : "VERIFYING ACCESS"}</span></header>
      <section className="fp-admin-heading">
        <div><div className="fp-admin-eyebrow">PAYMENT OPERATIONS</div><h1>Deposit receipt review</h1><p>Inspect customer-submitted evidence linked to a Paystack deposit reference.</p></div>
        <button type="button" className="fp-outline" onClick={() => void load()} disabled={loading}><RefreshCw size={15}/> Refresh queue</button>
      </section>
      {authorized === null && <section className="fp-admin-lock"><div className="fp-admin-lock-icon"><LockKeyhole size={25}/></div><div className="fp-admin-lock-copy"><h2>Verifying administrator access</h2><p>FlowPay is checking your signed-in session and server-side administrator role.</p></div></section>}
      {authorized === false && <section className="fp-admin-lock"><div className="fp-admin-lock-icon"><LockKeyhole size={25}/></div><div className="fp-admin-lock-copy"><h2>Administrator access required</h2><p>{authError || "This area is reserved for authorized FlowPay administrator accounts."}</p><ul><li>Customer receipt files are private.</li><li>Only verified administrator roles can review submissions.</li><li>Receipt review never posts a wallet credit.</li></ul></div><div className="fp-admin-status"><span/> Restricted administrator access</div></section>}
      {authorized === true && <>
        <div className="fp-receipt-review-banner"><ShieldCheck size={18}/><span><b>Evidence review only.</b> Accepting a receipt means the image has been reviewed; it does not confirm a payment, submit a payout or credit a customer wallet. Provider verification and the balanced ledger posting remain mandatory.</span></div>
        <div className="fp-receipt-review-toolbar">
          <div className="fp-receipt-review-tabs" role="group" aria-label="Receipt review status">
            {filters.map(item => <button type="button" key={item.value} className={filter === item.value ? "active" : ""} onClick={() => setFilter(item.value)}>{item.label}</button>)}
          </div>
          <span>{items.length} {items.length === 1 ? "submission" : "submissions"}</span>
        </div>
        {pageError && <div className="fp-admin-error" role="alert"><AlertCircle size={16}/>{pageError}</div>}
        {loading && <p className="fp-admin-muted" role="status">Loading private receipt submissions…</p>}
        {!loading && !pageError && items.length === 0 && <section className="fp-admin-empty"><FileImage size={28}/><b>No receipt submissions in this view</b><span>Customer receipt uploads will appear here when they are linked to a Paystack deposit reference.</span></section>}
        {!loading && items.length > 0 && <div className="fp-receipt-review-list">{items.map(item => <article className="fp-receipt-review-card" key={item.id}>
          <div className="fp-receipt-review-card-top">
            <div><span className="fp-admin-eyebrow">DEPOSIT EVIDENCE</span><h2>{money(item.amountMinor, item.currency)}</h2><p>{item.reference}</p></div>
            <span className={"fp-receipt-status " + item.reviewStatus}>{item.reviewStatus === "pending_review" ? "Awaiting review" : item.reviewStatus === "evidence_accepted" ? "Evidence accepted" : "Rejected"}</span>
          </div>
          <div className="fp-receipt-review-meta">
            <div><small>Customer</small><b>{item.customerName}</b><span>{item.customerEmail}</span></div>
            <div><small>Provider status</small><b>{item.depositStatus.toUpperCase()}</b><span>{date(item.createdAt)}</span></div>
            <div><small>Submitted file</small><b>{item.fileName}</b><span>{(item.fileSize / 1024).toFixed(0)} KB · {item.mimeType}</span></div>
          </div>
          {item.reviewNote && <div className="fp-receipt-review-note"><b>Review note</b><span>{item.reviewNote}</span></div>}
          <div className="fp-receipt-review-actions">
            <button type="button" className="fp-outline" disabled={previewBusy !== null} onClick={() => void openReceipt(item)}><Eye size={15}/>{previewBusy === item.id ? "Opening…" : "View receipt"}</button>
            {item.reviewStatus === "pending_review" && <><textarea value={notes[item.id] ?? ""} onChange={event => setNotes(current => ({ ...current, [item.id]: event.target.value }))} rows={2} maxLength={500} placeholder="Optional review note (required when rejecting)" aria-label={"Review note for " + item.reference}/><button type="button" className="fp-receipt-accept" disabled={reviewBusy !== null} onClick={() => void review(item, "evidence_accepted")}>{reviewBusy === item.id ? "Saving…" : <><Check size={15}/> Accept evidence</>}</button><button type="button" className="fp-receipt-reject" disabled={reviewBusy !== null} onClick={() => void review(item, "rejected")}><XCircle size={15}/> Reject</button></>}
          </div>
        </article>)}</div>}
      </>}
      <footer className="fp-admin-footer">© {new Date().getFullYear()} FlowPay · Administrative access is monitored and audited.</footer>
    </main>
    {preview && <div className="fp-receipt-preview-overlay" role="presentation" onClick={() => setPreview(null)}>
      <section className="fp-receipt-preview" role="dialog" aria-modal="true" aria-label="Private deposit receipt" onClick={event => event.stopPropagation()}>
        <header><div><b>Private receipt image</b><small>{preview.name}</small></div><button type="button" aria-label="Close receipt preview" onClick={() => setPreview(null)}><X size={18}/></button></header>
        <img src={preview.url} alt="Customer-submitted deposit receipt"/>
      </section>
    </div>}
  </div>;
}
