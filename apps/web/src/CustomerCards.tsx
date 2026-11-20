import { useEffect, useState } from "react";
import { getApiJwt } from "./auth-client";
import { AlertCircle, CreditCard, RefreshCw, ShieldCheck } from "lucide-react";

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

const CARD_STATUSES = new Set<Card["status"]>([
  "pending", "active", "frozen", "blocked", "closed", "failed"
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function parseCards(value: unknown): Card[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): Card[] => {
    const raw = asRecord(item);
    if (typeof raw.id !== "string" || !raw.id.trim()) return [];
    const month = typeof raw.expiryMonth === "number" && Number.isInteger(raw.expiryMonth) &&
      raw.expiryMonth >= 1 && raw.expiryMonth <= 12 ? raw.expiryMonth : null;
    const year = typeof raw.expiryYear === "number" && Number.isInteger(raw.expiryYear) &&
      raw.expiryYear >= 2000 && raw.expiryYear <= 2200 ? raw.expiryYear : null;
    return [{
      id: raw.id,
      provider: typeof raw.provider === "string" && raw.provider.trim() ? raw.provider : "Card provider",
      type: raw.type === "physical" ? "physical" : "virtual",
      status: typeof raw.status === "string" && CARD_STATUSES.has(raw.status as Card["status"])
        ? raw.status as Card["status"] : "pending",
      last4: typeof raw.last4 === "string" && /^[0-9]{4}$/.test(raw.last4) ? raw.last4 : null,
      expiryMonth: month,
      expiryYear: year,
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : ""
    }];
  });
}

export default function CustomerCards({ token, registeredName }: { token: string; registeredName?: string | null }) {
  const [cards, setCards] = useState<Card[]>([]);
  const [cardholderName, setCardholderName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const apiBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") || "";

  useEffect(() => {
    let active = true;
    if (!token || !apiBase) {
      setCards([]);
      setCardholderName(null);
      setError("Your authenticated cards service is not configured.");
      setLoading(false);
      return () => { active = false; };
    }
    setLoading(true);
    setError("");
    getApiJwt().then(jwt => fetch(apiBase + "/customer/cards", {
      method: "GET",
      credentials: "omit",
      headers: { Authorization: "Bearer " + jwt }
    })).then(async response => {
      const body = asRecord(await response.json().catch(() => ({})));
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Unable to load cards.");
      return body;
    }).then(body => {
      if (!active) return;
      setCardholderName(typeof body.cardholderName === "string" && body.cardholderName.trim()
        ? body.cardholderName.trim().slice(0, 100) : null);
      setCards(parseCards(body.cards));
    }).catch(cause => {
      if (!active) return;
      setCards([]);
      setCardholderName(null);
      setError(cause instanceof Error ? cause.message : "Unable to load cards.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token, apiBase, refresh]);

  return <section className="fp-panel fp-detail-panel">
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}>
      <div>
        <h2>Cards</h2>
        <p className="fp-muted">View issuer-confirmed card records. FlowPay does not issue customer bank account numbers or generate card credentials locally.</p>
      </div>
      <button type="button" className="fp-outline" onClick={() => setRefresh(value => value + 1)} disabled={loading}>
        <RefreshCw size={15}/> Refresh
      </button>
    </div>

    <div aria-label="FlowPay virtual card preview" style={{
      position:"relative",overflow:"hidden",minHeight:210,marginTop:18,padding:22,
      borderRadius:22,color:"#fff",background:"linear-gradient(125deg,#ff7a18 0%,#f04f24 52%,#9b2c2c 100%)",
      boxShadow:"0 16px 34px rgba(173,65,25,.22)",display:"flex",flexDirection:"column",justifyContent:"space-between"
    }}>
      <div aria-hidden="true" style={{position:"absolute",width:210,height:210,border:"1px solid rgba(255,255,255,.16)",borderRadius:"50%",right:-42,top:-92}}/>
      <div aria-hidden="true" style={{position:"absolute",width:170,height:170,border:"1px solid rgba(255,255,255,.13)",borderRadius:"50%",right:38,bottom:-112}}/>
      <div style={{position:"relative",display:"flex",alignItems:"center",justifyContent:"space-between",gap:10}}>
        <div style={{fontSize:18,fontWeight:900,letterSpacing:".08em"}}>flow<span style={{fontWeight:400}}>pay</span></div>
        <span style={{fontSize:10,fontWeight:800,letterSpacing:".12em",padding:"6px 9px",borderRadius:99,background:"rgba(255,255,255,.17)",border:"1px solid rgba(255,255,255,.24)"}}>
          {cards.find(card=>card.type==="virtual")?.status?.toUpperCase() ?? "PREVIEW ONLY"}
        </span>
      </div>
      <div style={{position:"relative",display:"grid",gap:12}}>
        <div style={{fontSize:11,opacity:.82,letterSpacing:".12em"}}>VIRTUAL CARD</div>
        <div style={{fontSize:22,fontWeight:650,letterSpacing:".13em",fontVariantNumeric:"tabular-nums"}}>
          {cards.find(card=>card.type==="virtual")?.last4
            ? "••••  ••••  ••••  " + cards.find(card=>card.type==="virtual")?.last4
            : "••••  ••••  ••••  ••••"}
        </div>
        <div style={{display:"flex",alignItems:"end",justifyContent:"space-between",gap:12}}>
          <div style={{display:"grid",gap:4,minWidth:0}}>
            <span style={{fontSize:9,opacity:.75,letterSpacing:".12em"}}>CARDHOLDER</span>
            <strong style={{fontSize:13,letterSpacing:".06em",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
              {(cardholderName || registeredName?.trim() || "FLOWPAY CUSTOMER").toUpperCase()}
            </strong>
          </div>
          <div style={{display:"grid",gap:4,textAlign:"right",flexShrink:0}}>
            <span style={{fontSize:9,opacity:.75,letterSpacing:".12em"}}>VALID THRU</span>
            <strong style={{fontSize:13,letterSpacing:".06em"}}>
              {(() => { const card=cards.find(item=>item.type==="virtual"); return card?.expiryMonth && card?.expiryYear ? String(card.expiryMonth).padStart(2,"0") + "/" + String(card.expiryYear).slice(-2) : "••/••"; })()}
            </strong>
          </div>
        </div>
      </div>
      <div style={{position:"relative",fontSize:10,opacity:.82}}>
        {cards.some(card=>card.type==="virtual") ? "Issuer-linked card preview · Sensitive details protected" : "Design preview · No card has been issued"}
      </div>
    </div>

    <div className="fp-detail-list" style={{marginTop:14}}>
      <div><span>Cardholder name</span><b>{cardholderName || registeredName?.trim() || "Not available on this profile"}</b></div>
      <div><span>Card number</span><b>Available only after issuer-confirmed issuance</b></div>
    </div>

    <div style={{marginTop:20,border:"1px solid var(--fp-border, #e5e7eb)",borderRadius:16,padding:16,display:"grid",gap:10}}>
      <div style={{display:"flex",alignItems:"center",gap:9}}>
        <ShieldCheck size={19}/><b>FlowPay receiving identity</b>
      </div>
      <p className="fp-muted" style={{margin:0}}>
        Customers use their permanent 10-digit FlowPay ID or Neon-verified mobile number to find the same FlowPay wallet. This page does not issue or display a customer NUBAN.
      </p>
      <div className="fp-preview-warning">
        <ShieldCheck size={17}/> Phone-number transfers from other Nigerian banks require NIBSS National Payment Stack participant approval, integration and certification. Historical provider settlement records are retained; new customer NUBAN issuance is disabled.
      </div>
    </div>

    <div style={{marginTop:16,border:"1px solid var(--fp-border, #e5e7eb)",borderRadius:16,padding:16,display:"grid",gap:8}}>
      <div style={{display:"flex",alignItems:"center",gap:9}}><CreditCard size={18}/><b>Virtual card credentials</b></div>
      <p className="fp-muted" style={{margin:0}}>
        Full card number, CVV/CVC, expiry date and card PIN can appear only through an approved secure issuer flow. FlowPay will not generate or store fake card credentials.
      </p>
      <div className="fp-preview-warning">
        <ShieldCheck size={17}/> Card issuance and secure credential reveal remain unavailable until an approved issuer confirms this FlowPay integration.
      </div>
    </div>

    {loading && <p className="fp-muted">Loading your card records…</p>}
    {error && <div className="fp-preview-warning" role="alert"><AlertCircle size={17}/> {error}</div>}
    {!loading && !error && cards.length === 0 && <div className="fp-empty">
      <CreditCard size={24}/><b>No card records yet</b>
      <span>Your virtual or physical card will appear here after an approved issuer confirms creation.</span>
    </div>}
    {!loading && !error && cards.length > 0 && <div className="fp-feature-list">
      {cards.map(card => <div key={card.id} style={{alignItems:"center",gap:12}}>
        <CreditCard size={20}/>
        <div style={{minWidth:0,flex:1,display:"grid",gap:4}}>
          <b>{card.type === "virtual" ? "Virtual card" : "Physical card"}{card.last4 ? " •••• " + card.last4 : ""}</b>
          <small>{card.provider.replace(/_/g," ")}</small>
          <small>Card number: {card.last4 ? "•••• •••• •••• " + card.last4 : "Not issued"}</small>
          <small>Expiry: {card.expiryMonth && card.expiryYear
            ? String(card.expiryMonth).padStart(2,"0") + "/" + card.expiryYear : "Not available"}</small>
          <small>CVV/CVC: Not stored · Card PIN: issuer-managed; use issuer reset if needed</small>
        </div>
        <span>{card.status}</span>
      </div>)}
    </div>}
  </section>;
}
