import { useEffect, useState } from "react";
import { ArrowUpRight, RefreshCw, ShieldCheck, AlertCircle } from "lucide-react";

type Transfer = { id: string; type: string; status: string; createdAt: string; destinationAccountMasked: string };

export default function MoneySent({ token }: { token: string }) {
  const [items, setItems] = useState<Transfer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const apiBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") || "";

  useEffect(() => {
    let active = true;
    if (!token || !apiBase) { setError("Your authenticated transfer history service is not configured."); setLoading(false); return () => { active = false; }; }
    setLoading(true); setError("");
    fetch(apiBase + "/customer/money-sent", { method: "GET", credentials: "omit", headers: { Authorization: "Bearer " + token } })
      .then(async response => { const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || "Unable to load transfer history."); return data; })
      .then(data => { if (active) setItems(Array.isArray(data.transfers) ? data.transfers : []); })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "Unable to load transfer history."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token, apiBase, refresh]);

  return <section className="fp-panel fp-detail-panel">
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}>
      <div><h2>Money Sent</h2><p className="fp-muted">Your recorded simulated transfer history.</p></div>
      <button type="button" className="fp-outline" onClick={() => setRefresh(value => value + 1)} disabled={loading}><RefreshCw size={15}/> Refresh</button>
    </div>
    <div className="fp-preview-warning"><ShieldCheck size={17}/> These records are simulation-only. No live bank transfer is initiated or confirmed by this page.</div>
    {loading && <p className="fp-muted">Loading transfer records…</p>}
    {error && <div className="fp-preview-warning"><AlertCircle size={17}/> {error}</div>}
    {!loading && !error && items.length === 0 && <div className="fp-empty"><ArrowUpRight size={24}/><b>No simulated transfers recorded</b><span>Transfer records will appear here after a simulation is created and recorded in the ledger.</span></div>}
    {!loading && !error && items.length > 0 && <div className="fp-feature-list">{items.map(item => <div key={item.id} style={{alignItems:"center",gap:12}}>
      <ArrowUpRight size={19}/><div style={{minWidth:0,flex:1,display:"grid",gap:4}}><b>{item.type.replaceAll("_"," ")}</b><small>Destination account · {item.destinationAccountMasked}</small><small>{new Date(item.createdAt).toLocaleString()}</small></div><span>{item.status}</span>
    </div>)}</div>}
  </section>;
}
