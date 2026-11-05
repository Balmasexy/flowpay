import { useEffect, useState } from "react";
import { ArrowUpRight, RefreshCw, ShieldCheck, AlertCircle } from "lucide-react";

type Transfer = { id: string; type: string; status: string; createdAt: string; destinationAccountMasked: string };

function safeText(value: unknown, fallback: string, max = 120): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : fallback;
}

function parseTransfer(value: unknown): Transfer | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = safeText(row.id, "", 128);
  const type = safeText(row.type, "", 60);
  const status = safeText(row.status, "", 40);
  if (!id || !type || !status) return null;
  return {
    id,
    type,
    status,
    createdAt: typeof row.createdAt === "string" ? row.createdAt : "",
    destinationAccountMasked: safeText(row.destinationAccountMasked, "Unavailable", 80),
  };
}

function formatDate(value: string): string {
  if (!value) return "Date unavailable";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleString();
}

export default function MoneySent({ token }: { token: string }) {
  const [items, setItems] = useState<Transfer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const apiBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") || "";

  useEffect(() => {
    let active = true;
    if (!token || !apiBase) {
      setItems([]);
      setError("Your authenticated transfer history service is not configured.");
      setLoading(false);
      return () => { active = false; };
    }
    setLoading(true);
    setError("");
    fetch(apiBase + "/customer/money-sent", {
      method: "GET",
      credentials: "omit",
      headers: { Authorization: "Bearer " + token },
    })
      .then(async response => {
        const data: unknown = await response.json().catch(() => ({}));
        if (!response.ok) {
          const message = data && typeof data === "object" && "error" in data && typeof data.error === "string"
            ? data.error
            : "Unable to load transfer history.";
          throw new Error(message);
        }
        return data;
      })
      .then(data => {
        if (!active) return;
        const transfers = data && typeof data === "object" && "transfers" in data
          ? (data as { transfers?: unknown }).transfers
          : null;
        setItems(Array.isArray(transfers)
          ? transfers.map(parseTransfer).filter((item): item is Transfer => item !== null)
          : []);
      })
      .catch(reason => {
        if (active) {
          setItems([]);
          setError(reason instanceof Error ? reason.message : "Unable to load transfer history.");
        }
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token, apiBase, refresh]);

  return <section className="fp-panel fp-detail-panel">
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}>
      <div><h2>Transfer History</h2><p className="fp-muted">Review your outgoing FlowPay wallet transfers and legacy simulated transfer records.</p></div>
      <button type="button" className="fp-outline" onClick={() => setRefresh(value => value + 1)} disabled={loading}><RefreshCw size={15}/> Refresh</button>
    </div>
    <div className="fp-preview-warning"><ShieldCheck size={17}/> FlowPay wallet-to-wallet transfers are recorded in the balanced customer ledger. External bank payouts remain disabled until provider disbursement and reconciliation are configured.</div>
    {loading && <p className="fp-muted">Loading transfer records…</p>}
    {error && <div className="fp-preview-warning"><AlertCircle size={17}/> {error}</div>}
    {!loading && !error && items.length === 0 && <div className="fp-empty"><ArrowUpRight size={24}/><b>No outgoing transfers recorded</b><span>Completed FlowPay wallet transfers will appear here after both ledger entries are posted.</span></div>}
    {!loading && !error && items.length > 0 && <div className="fp-feature-list">{items.map(item => <div key={item.id} style={{alignItems:"center",gap:12}}>
      <ArrowUpRight size={19}/><div style={{minWidth:0,flex:1,display:"grid",gap:4}}><b>{item.type.replace(/_/g," ")}</b><small>Destination account · {item.destinationAccountMasked}</small><small>{formatDate(item.createdAt)}</small></div><span>{item.status}</span>
    </div>)}</div>}
  </section>;
}
