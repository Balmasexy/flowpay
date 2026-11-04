import { useEffect, useState } from "react";
import { Activity, AlertCircle, RefreshCw } from "lucide-react";

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

const VALID_STATUSES = new Set<Transaction["status"]>(["posted", "reversed"]);

function parseTransactions(value: unknown): Transaction[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): Transaction[] => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Record<string, unknown>;
    if (typeof raw.id !== "string" || !raw.id.trim()) return [];
    const amount = typeof raw.customerLedgerAmountMinor === "string" || typeof raw.customerLedgerAmountMinor === "number"
      ? String(raw.customerLedgerAmountMinor) : "";
    const entryCount = typeof raw.customerEntryCount === "number" && Number.isInteger(raw.customerEntryCount) && raw.customerEntryCount >= 0
      ? raw.customerEntryCount : 0;
    return [{
      id: raw.id,
      type: typeof raw.type === "string" && raw.type.trim() ? raw.type : "transaction",
      description: typeof raw.description === "string" ? raw.description : "",
      status: typeof raw.status === "string" && VALID_STATUSES.has(raw.status as Transaction["status"]) ? raw.status as Transaction["status"] : "posted",
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
      postedAt: typeof raw.postedAt === "string" ? raw.postedAt : null,
      currency: typeof raw.currency === "string" && /^[A-Z]{3}$/.test(raw.currency) ? raw.currency : "NGN",
      customerLedgerAmountMinor: amount,
      customerEntryCount: entryCount
    }];
  });
}

export default function CustomerActivity({ token }: { token: string }) {
  const [items, setItems] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const apiBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") || "";

  useEffect(() => {
    let active = true;
    if (!token || !apiBase) {
      setItems([]);
      setError("Your authenticated activity service is not configured.");
      setLoading(false);
      return () => { active = false; };
    }
    setLoading(true);
    setError("");
    fetch(apiBase + "/customer/activity?limit=100", {
      method: "GET",
      credentials: "omit",
      headers: { Authorization: "Bearer " + token }
    }).then(async response => {
      const data: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : "Unable to load transaction activity.";
        throw new Error(message);
      }
      return data;
    }).then(data => {
      if (active) {
        const payload = data && typeof data === "object" && "transactions" in data ? data.transactions : [];
        setItems(parseTransactions(payload));
      }
    }).catch(reason => {
      if (active) {
        setItems([]);
        setError(reason instanceof Error ? reason.message : "Unable to load transaction activity.");
      }
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token, apiBase, refresh]);

  const formatAmount = (minor: string, currency: string) => {
    const value = Number(minor);
    if (!minor || !Number.isFinite(value)) return "Unavailable";
    try {
      return new Intl.NumberFormat("en-NG", { style: "currency", currency, minimumFractionDigits: 2 }).format(value / 100);
    } catch {
      return "Unavailable";
    }
  };

  const formatDate = (value: string) => {
    if (!value) return "Date unavailable";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleString();
  };

  return <section className="fp-panel fp-detail-panel">
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}>
      <div><h2>Transaction history</h2><p className="fp-muted">Verified posted and reversed ledger activity linked to your customer account.</p></div>
      <button type="button" className="fp-outline" onClick={() => setRefresh(value => value + 1)} disabled={loading}><RefreshCw size={15}/> Refresh</button>
    </div>
    <div className="fp-preview-warning"><Activity size={17}/> Amounts below are customer ledger-entry totals. Incoming/outgoing direction is not labelled until the ledger sign convention is verified.</div>
    {loading && <p className="fp-muted">Loading verified activity…</p>}
    {error && <div className="fp-preview-warning"><AlertCircle size={17}/> {error}</div>}
    {!loading && !error && items.length === 0 && <div className="fp-empty"><Activity size={24}/><b>No posted transaction history yet</b><span>Only records confirmed by the FlowPay ledger appear here.</span></div>}
    {!loading && !error && items.length > 0 && <div className="fp-feature-list">
      {items.map(item => <div key={item.id} style={{alignItems:"flex-start",gap:12}}>
        <Activity size={18}/>
        <div style={{minWidth:0,flex:1,display:"grid",gap:4}}>
          <b>{item.description || item.type.replace(/_/g," ")}</b>
          <small>{item.type.replace(/_/g," ")} · {formatDate(item.postedAt || item.createdAt)}</small>
          <small>{item.customerEntryCount} customer ledger {item.customerEntryCount === 1 ? "entry" : "entries"}</small>
        </div>
        <div style={{textAlign:"right",display:"grid",gap:4}}>
          <b>{formatAmount(item.customerLedgerAmountMinor,item.currency)}</b>
          <small>{item.status}</small>
        </div>
      </div>)}
    </div>}
  </section>;
}
