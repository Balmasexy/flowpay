import { useEffect, useState } from "react";
import { Activity, AlertCircle, Download, FileText, RefreshCw, ShieldCheck } from "lucide-react";

type Transaction = {
  id: string;
  type: string;
  description: string;
  status: "posted" | "reversed";
  createdAt: string;
  postedAt: string | null;
  currency: string;
  customerLedgerAmountMinor: string;
  customerEntryCount: number;
};

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") || "";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseTransaction(value: unknown): Transaction | null {
  const row = asRecord(value);
  if (!row || typeof row.id !== "string" || !row.id.trim() || typeof row.type !== "string" || typeof row.status !== "string" || !["posted", "reversed"].includes(row.status) || typeof row.createdAt !== "string" || typeof row.currency !== "string" || !/^[A-Z]{3}$/.test(row.currency)) return null;
  if (typeof row.customerLedgerAmountMinor !== "string" && typeof row.customerLedgerAmountMinor !== "number") return null;
  const amount = String(row.customerLedgerAmountMinor);
  if (!/^-?\\d+$/.test(amount) || !Number.isSafeInteger(Number(amount)) || !Number.isSafeInteger(row.customerEntryCount) || (row.customerEntryCount as number) < 0) return null;
  return {
    id: row.id.slice(0, 128), type: row.type.slice(0, 60),
    description: typeof row.description === "string" ? row.description.slice(0, 240) : "",
    status: row.status as Transaction["status"], createdAt: row.createdAt,
    postedAt: typeof row.postedAt === "string" ? row.postedAt : null,
    currency: row.currency, customerLedgerAmountMinor: amount,
    customerEntryCount: row.customerEntryCount as number,
  };
}

function csvCell(value: unknown) {
  let text = String(value ?? "");
  if (/^[\\s\\u0000-\\u001f]*[=+@]/.test(text) || /^[\\s\\u0000-\\u001f]*-/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

export default function DocumentsPage({ token, go }: { token: string; go: (path: string) => void }) {
  const [items, setItems] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let active = true;
    if (!token || !API_BASE) {
      setItems([]);
      setError("Your authenticated FlowPay activity service is not configured.");
      setLoading(false);
      return () => { active = false; };
    }
    setLoading(true);
    setError("");
    fetch(API_BASE + "/customer/activity?limit=100", {
      method: "GET",
      credentials: "omit",
      headers: { Authorization: "Bearer " + token }
    }).then(async response => {
      const data: unknown = await response.json().catch(() => null);
      const body = asRecord(data);
      if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error.slice(0, 200) : "Unable to load verified account activity.");
      if (!Array.isArray(body?.transactions)) throw new Error("The activity service returned an invalid response.");
      return body.transactions;
    }).then(transactions => {
      if (active) setItems(transactions.map(parseTransaction).filter((item): item is Transaction => item !== null));
    }).catch(reason => {
      if (active) { setItems([]); setError(reason instanceof Error ? reason.message : "Unable to load verified account activity."); }
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token, refresh]);

  function downloadActivity() {
    if (!items.length) return;
    const rows = [
      ["Transaction ID", "Type", "Description", "Status", "Created At", "Posted At", "Currency", "Customer Ledger Amount (minor units)", "Customer Entry Count"],
      ...items.map(item => [item.id, item.type, item.description, item.status, item.createdAt, item.postedAt ?? "", item.currency, item.customerLedgerAmountMinor, item.customerEntryCount])
    ];
    const csv = rows.map(row => row.map(csvCell).join(",")).join("\r\n");
    const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "flowpay-verified-activity-export.csv";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  return <section className="fp-panel fp-detail-panel">
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}>
      <div><h2>Documents & statements</h2><p className="fp-muted">Access the records FlowPay can currently verify for your signed-in account.</p></div>
      <button type="button" className="fp-outline" onClick={() => setRefresh(value => value + 1)} disabled={loading}><RefreshCw size={15}/> Refresh</button>
    </div>
    <div className="fp-preview-warning"><ShieldCheck size={17}/> Customer documents are private. Secure document storage and identity-document submission are not yet connected. Do not upload identity documents to an unverified service.</div>

    <div className="fp-doc-list">
      <div><FileText size={19}/><span>Government identity document<small>Secure upload is not available yet</small></span><b>Not submitted</b></div>
      <div><FileText size={19}/><span>Proof of address<small>Secure upload is not available yet</small></span><b>Not submitted</b></div>
      <div><FileText size={19}/><span>Account-opening documents<small>No customer-specific file is currently available here</small></span><b>Unavailable</b></div>
      <div><FileText size={19}/><span>Official bank statement<small>Not generated by the current FlowPay service</small></span><b>Unavailable</b></div>
      <div><Activity size={19}/><span>Verified transaction activity export<small>Authenticated ledger activity · maximum 100 records</small></span><b>{loading ? "Loading…" : error ? "Unavailable" : items.length + " records"}</b></div>
    </div>

    {loading && <p className="fp-muted">Loading your authenticated activity…</p>}
    {error && <div className="fp-preview-warning" role="alert"><AlertCircle size={17}/>{error}</div>}
    {!loading && !error && items.length === 0 && <div className="fp-empty"><Activity size={24}/><b>No verified activity to export</b><span>When ledger activity is available, you can export it from this page.</span></div>}
    {!loading && !error && items.length > 0 && <div style={{display:"grid",gap:10,marginTop:16}}>
      <button type="button" className="fp-primary" onClick={downloadActivity}><Download size={16}/> Download activity CSV ({items.length})</button>
      <p className="fp-muted">This is a data export, not an official bank statement. Amounts are preserved in ledger minor units and transaction direction is not inferred.</p>
    </div>}

    <div style={{display:"flex",gap:10,flexWrap:"wrap",marginTop:18}}>
      <button type="button" className="fp-outline" onClick={() => go("/activity")}>View transaction history</button>
      <button type="button" className="fp-outline" onClick={() => go("/support")}>Ask for document support</button>
    </div>
  </section>;
}
