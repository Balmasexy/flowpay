import { useEffect, useState } from "react";
import { CreditCard, RefreshCw, ShieldCheck, AlertCircle } from "lucide-react";

type Card = {
  id: string;
  provider: string;
  type: "virtual" | "physical";
  status: "pending" | "active" | "frozen" | "blocked" | "closed" | "failed";
  last4: string | null;
  expiryMonth: number | null;
  expiryYear: number | null;
  createdAt: string;
};

export default function CustomerCards({ token }: { token: string }) {
  const [cards, setCards] = useState<Card[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const apiBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") || "";

  useEffect(() => {
    let active = true;
    if (!token || !apiBase) {
      setError("Your authenticated cards service is not configured.");
      setLoading(false);
      return () => { active = false; };
    }
    setLoading(true);
    setError("");
    fetch(apiBase + "/customer/cards", {
      method: "GET", credentials: "omit",
      headers: { Authorization: "Bearer " + token }
    }).then(async response => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Unable to load cards.");
      return data;
    }).then(data => { if (active) setCards(Array.isArray(data.cards) ? data.cards : []); })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "Unable to load cards."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token, apiBase, refresh]);

  return <section className="fp-panel fp-detail-panel">
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}>
      <div><h2>Cards</h2><p className="fp-muted">Your card records securely stored in FlowPay.</p></div>
      <button type="button" className="fp-outline" onClick={() => setRefresh(value => value + 1)} disabled={loading}><RefreshCw size={15}/> Refresh</button>
    </div>
    <div className="fp-preview-warning"><ShieldCheck size={17}/> Card creation, card-detail reveal, PIN changes and freeze/unfreeze actions are disabled until a verified card provider workflow is connected. Full card numbers and security codes are never shown here.</div>
    {loading && <p className="fp-muted">Loading your card records…</p>}
    {error && <div className="fp-preview-warning"><AlertCircle size={17}/> {error}</div>}
    {!loading && !error && cards.length === 0 && <div className="fp-empty"><CreditCard size={24}/><b>No card records yet</b><span>Your virtual or physical card will appear here after a verified card-issuing workflow creates it.</span></div>}
    {!loading && !error && cards.length > 0 && <div className="fp-feature-list">
      {cards.map(card => <div key={card.id} style={{alignItems:"center",gap:12}}>
        <CreditCard size={20}/>
        <div style={{minWidth:0,flex:1,display:"grid",gap:4}}>
          <b>{card.type === "virtual" ? "Virtual card" : "Physical card"}{card.last4 ? " •••• " + card.last4 : ""}</b>
          <small>{card.provider.replaceAll("_"," ")}{card.expiryMonth && card.expiryYear ? " · Expires " + String(card.expiryMonth).padStart(2,"0") + "/" + card.expiryYear : ""}</small>
        </div>
        <span>{card.status}</span>
      </div>)}
    </div>}
  </section>;
}
