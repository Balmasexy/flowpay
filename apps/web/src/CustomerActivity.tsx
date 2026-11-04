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

export default function CustomerActivity({ token }: { token: string }) {
  const [items, setItems] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const apiBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\\/$/, "") || "";

  useEffect(() => {
    let active = true;
    if (!token || !apiBase) {
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
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Unable to load transaction activity.");
      return data;
    }).then(data => {
      if (active) setItems(Array.isArray(data.transactions) ? data.transactions : []);
    }).catch(reason => {
      if (active) setError(reason instanceof Error ? reason.message : "Unable to load transaction activity.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token, apiBase, refresh]);

  const formatAmount = (minor: string, currency: string) => {
    const value = Number(minor);
    if (!Number.isFinite(value)) return "Unavailable";
    return new Intl.NumberFormat("en-NG", { style: "currency", currency, minimumFractionDigits: 2 }).format(Math.abs(value) / 100);
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
          <b>{item.description || item.type.replaceAll("_"," ")}</b>
          <small>{item.type.replaceAll("_"," ")} · {new Date(item.postedAt || item.createdAt).toLocaleString()}</small>
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
