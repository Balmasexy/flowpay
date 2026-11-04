import { useEffect, useState } from "react";
import { ArrowDownLeft, RefreshCw, ShieldCheck, AlertCircle } from "lucide-react";

type Deposit = { id: string; provider: string; reference: string; amountMinor: string; currency: string; status: string; createdAt: string; verifiedAt: string | null };

export default function MoneyReceived({ token }: { token: string }) {
  const [items, setItems] = useState<Deposit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const apiBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") || "";

  useEffect(() => {
    let active = true;
    if (!token || !apiBase) { setError("Your authenticated deposits service is not configured."); setLoading(false); return () => { active = false; }; }
    setLoading(true); setError("");
    fetch(apiBase + "/customer/money-received", { method: "GET", credentials: "omit", headers: { Authorization: "Bearer " + token } })
      .then(async response => { const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || "Unable to load received payments."); return data; })
      .then(data => { if (active) setItems(Array.isArray(data.deposits) ? data.deposits : []); })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "Unable to load received payments."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token, apiBase, refresh]);

  const formatAmount = (minor: string, currency: string) => {
    const value = Number(minor) / 100;
    if (!Number.isFinite(value)) return "Amount unavailable";
    try { return new Intl.NumberFormat("en-NG", { style: "currency", currency }).format(value); }
    catch { return currency + " " + value.toFixed(2); }
  };

  return <section className="fp-panel fp-detail-panel">
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}>
      <div><h2>Money Received</h2><p className="fp-muted">Verified customer deposits recorded in the FlowPay ledger.</p></div>
      <button type="button" className="fp-outline" onClick={() => setRefresh(value => value + 1)} disabled={loading}><RefreshCw size={15}/> Refresh</button>
    </div>
    <div className="fp-preview-warning"><ShieldCheck size={17}/> This view includes only posted Flutterwave test deposits. Live payment collection is disabled.</div>
    {loading && <p className="fp-muted">Loading verified deposits…</p>}
    {error && <div className="fp-preview-warning"><AlertCircle size={17}/> {error}</div>}
    {!loading && !error && items.length === 0 && <div className="fp-empty"><ArrowDownLeft size={24}/><b>No verified deposits yet</b><span>Successful test deposits will appear here after they are verified and posted to your ledger.</span></div>}
    {!loading && !error && items.length > 0 && <div className="fp-feature-list">{items.map(item => <div key={item.id} style={{alignItems:"center",gap:12}}>
      <ArrowDownLeft size={19}/><div style={{minWidth:0,flex:1,display:"grid",gap:4}}><b>{formatAmount(item.amountMinor,item.currency)}</b><small>{item.provider} · {item.reference}</small><small>{item.verifiedAt ? "Verified " + new Date(item.verifiedAt).toLocaleString() : "Posted " + new Date(item.createdAt).toLocaleString()}</small></div><span>Posted</span>
    </div>)}</div>}
  </section>;
}
