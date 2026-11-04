import { useEffect, useState } from "react";
import { ArrowDownLeft, RefreshCw, ShieldCheck, AlertCircle } from "lucide-react";

type Deposit = {
  id: string;
  provider: string;
  reference: string;
  amountMinor: string;
  currency: string;
  createdAt: string;
  verifiedAt: string | null;
};

function textValue(value: unknown, fallback: string, max = 120): string {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, max)
    : fallback;
}

function parseDeposit(value: unknown, index: number): Deposit | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const rawAmount = row.amountMinor;
  if (
    !(typeof rawAmount === "string" || typeof rawAmount === "number") ||
    !/^\\d+$/.test(String(rawAmount)) ||
    !Number.isSafeInteger(Number(rawAmount))
  ) return null;

  const rawCurrency = typeof row.currency === "string" ? row.currency.toUpperCase() : "";
  const currency = /^[A-Z]{3}$/.test(rawCurrency) ? rawCurrency : "NGN";
  const rawId = textValue(row.id, "", 128);
  const createdAt = typeof row.createdAt === "string" ? row.createdAt : "";
  const verifiedAt = typeof row.verifiedAt === "string" ? row.verifiedAt : null;

  return {
    id: rawId || "deposit-" + index,
    provider: textValue(row.provider, "Payment provider"),
    reference: textValue(row.reference, "Reference unavailable"),
    amountMinor: String(rawAmount),
    currency,
    createdAt,
    verifiedAt,
  };
}

function formatDate(value: string | null): string {
  if (!value) return "Date unavailable";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleString();
}

export default function MoneyReceived({ token }: { token: string }) {
  const [items, setItems] = useState<Deposit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const apiBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\\/$/, "") || "";

  useEffect(() => {
    let active = true;
    if (!token || !apiBase) {
      setItems([]);
      setError("Your authenticated deposits service is not configured.");
      setLoading(false);
      return () => { active = false; };
    }
    setLoading(true);
    setError("");
    fetch(apiBase + "/customer/money-received", {
      method: "GET",
      credentials: "omit",
      headers: { Authorization: "Bearer " + token },
    })
      .then(async response => {
        const data: unknown = await response.json().catch(() => ({}));
        if (!response.ok) {
          const message = data && typeof data === "object" && "error" in data && typeof data.error === "string"
            ? data.error
            : "Unable to load received payments.";
          throw new Error(message);
        }
        return data;
      })
      .then(data => {
        if (!active) return;
        const deposits = data && typeof data === "object" && "deposits" in data
          ? (data as { deposits?: unknown }).deposits
          : null;
        setItems(Array.isArray(deposits)
          ? deposits.map(parseDeposit).filter((item): item is Deposit => item !== null)
          : []);
      })
      .catch(reason => {
        if (active) {
          setItems([]);
          setError(reason instanceof Error ? reason.message : "Unable to load received payments.");
        }
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token, apiBase, refresh]);

  const formatAmount = (minor: string, currency: string) => {
    const value = Number(minor) / 100;
    if (!Number.isFinite(value)) return "Amount unavailable";
    try {
      return new Intl.NumberFormat("en-NG", { style: "currency", currency }).format(value);
    } catch {
      return currency + " " + value.toFixed(2);
    }
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
      <ArrowDownLeft size={19}/><div style={{minWidth:0,flex:1,display:"grid",gap:4}}><b>{formatAmount(item.amountMinor,item.currency)}</b><small>{item.provider} · {item.reference}</small><small>{item.verifiedAt ? "Verified " + formatDate(item.verifiedAt) : "Posted " + formatDate(item.createdAt)}</small></div><span>Posted</span>
    </div>)}</div>}
  </section>;
}
