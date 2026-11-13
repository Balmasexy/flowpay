import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AlertCircle, CheckCircle2, CreditCard, Plus, RefreshCw, ShieldCheck, XCircle } from "lucide-react";

type PaymentMethod = {
  type?: string;
  account_number?: string;
  account_name?: string;
  bank?: string;
};

type VirtualTerminal = {
  id?: number;
  code: string;
  name: string;
  domain?: "test" | "live" | string;
  active: boolean;
  currency?: string;
  paymentMethods?: PaymentMethod[];
  created_at?: string;
};

type Props = { token: string; apiBase: string };

export default function PaystackVirtualTerminalManager({ token, apiBase }: Props) {
  const [terminals, setTerminals] = useState<VirtualTerminal[]>([]);
  const [environment, setEnvironment] = useState<"test" | "live" | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [rename, setRename] = useState<Record<string, string>>({});

  const request = useCallback(async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(apiBase + path, {
      method,
      credentials: "omit",
      headers: {
        Authorization: "Bearer " + token,
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const payload: unknown = await response.json().catch(() => ({}));
    const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    if (!response.ok) {
      throw new Error(typeof root.message === "string" ? root.message : typeof root.error === "string" ? root.error : "Paystack Virtual Terminal request failed.");
    }
    return root;
  }, [apiBase, token]);

  const load = useCallback(async () => {
    if (!token || !apiBase) { setError("A secure FlowPay admin session is required."); setLoading(false); return; }
    setLoading(true); setError("");
    try {
      const root = await request("/admin/paystack/virtual-terminals");
      setEnvironment(root.environment === "live" || root.environment === "test" ? root.environment : null);
      setTerminals(Array.isArray(root.data) ? root.data.filter((item): item is VirtualTerminal => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return false;
        const row = item as Record<string, unknown>;
        return typeof row.code === "string" && typeof row.name === "string" && typeof row.active === "boolean";
      }) : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load Paystack terminals.");
    } finally { setLoading(false); }
  }, [apiBase, request, token]);

  useEffect(() => { void load(); }, [load]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const root = await request("/admin/paystack/virtual-terminals", "POST", {
        name: name.trim(),
        destinations: [{ target: phone.trim(), name: "FlowPay terminal notifications" }]
      });
      const created = root.data as VirtualTerminal | undefined;
      setMessage(created?.code ? "Paystack confirmed terminal creation: " + created.code : "Paystack accepted the terminal creation request.");
      setName(""); setPhone("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Terminal creation failed.");
    } finally { setBusy(false); }
  };

  const updateName = async (terminal: VirtualTerminal) => {
    const nextName = (rename[terminal.code] ?? terminal.name).trim();
    if (nextName.length < 2 || nextName.length > 80 || busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      await request("/admin/paystack/virtual-terminals/" + encodeURIComponent(terminal.code), "PUT", { name: nextName });
      setMessage("Terminal name updated with Paystack.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Terminal update failed.");
    } finally { setBusy(false); }
  };

  const deactivate = async (terminal: VirtualTerminal) => {
    if (busy || !window.confirm("Deactivate " + terminal.name + " in Paystack? It will stop accepting new payments.")) return;
    setBusy(true); setError(""); setMessage("");
    try {
      await request("/admin/paystack/virtual-terminals/" + encodeURIComponent(terminal.code) + "/deactivate", "PUT");
      setMessage("Paystack confirmed terminal deactivation.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Terminal deactivation failed.");
    } finally { setBusy(false); }
  };

  return (
    <section className="fp-admin-review-guidance" aria-labelledby="fp-paystack-vt-title" style={{ display: "block", marginTop: 18 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <CreditCard size={20}/>
          <div>
            <h2 id="fp-paystack-vt-title" style={{ margin: 0 }}>Paystack Virtual Terminals</h2>
            <p style={{ margin: "4px 0 0" }}>Manage FlowPay payment-collection points using your approved Paystack integration.</p>
          </div>
        </div>
        <button type="button" className="fp-admin-refresh" onClick={() => void load()} disabled={loading || busy}><RefreshCw size={15}/> Refresh</button>
      </div>
      <div style={{ margin: "14px 0", padding: 12, borderRadius: 10, background: "rgba(255,255,255,.7)", border: "1px solid rgba(20,35,50,.12)" }}>
        <b>Environment:</b> {environment ? environment.toUpperCase() : "Unavailable"}
        <p style={{ margin: "6px 0 0", fontSize: 13 }}>Virtual Terminal payments settle to the Paystack merchant integration. This management page does not create customer wallet credits; customer attribution and ledger reconciliation must be configured and verified separately.</p>
      </div>
      <form onSubmit={create} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: 10, alignItems: "end" }}>
        <label style={{ display: "grid", gap: 5 }}>Terminal name
          <input value={name} onChange={e => setName(e.target.value)} minLength={2} maxLength={80} placeholder="e.g. FlowPay Sales Desk" required disabled={busy}/>
        </label>
        <label style={{ display: "grid", gap: 5 }}>WhatsApp destination
          <input value={phone} onChange={e => setPhone(e.target.value)} inputMode="tel" placeholder="+2348012345678" required disabled={busy}/>
        </label>
        <button type="submit" className="fp-admin-refresh" disabled={busy || name.trim().length < 2 || !phone.trim()}><Plus size={15}/>{busy ? "Working…" : "Create terminal"}</button>
      </form>
      {message && <p role="status" style={{ display: "flex", gap: 8, alignItems: "center" }}><CheckCircle2 size={16}/>{message}</p>}
      {error && <p role="alert" style={{ display: "flex", gap: 8, alignItems: "center" }}><AlertCircle size={16}/>{error}</p>}
      {loading ? <p>Loading Paystack terminals…</p> : terminals.length === 0 ? <p>No Virtual Terminals were returned by Paystack for this integration.</p> :
        <div style={{ display: "grid", gap: 12, marginTop: 14 }}>
          {terminals.map(terminal => <article key={terminal.code} style={{ background: "rgba(255,255,255,.75)", border: "1px solid rgba(20,35,50,.14)", borderRadius: 12, padding: 14 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
              <div><b>{terminal.name}</b><div style={{ fontSize: 12, opacity: .75 }}>{terminal.code} · {terminal.currency ?? "Currency not supplied"} · {terminal.domain ?? environment ?? "Environment unavailable"}</div></div>
              <span style={{ fontSize: 12, fontWeight: 700, color: terminal.active ? "#167a45" : "#8b3d3d" }}>{terminal.active ? "ACTIVE" : "INACTIVE"}</span>
            </div>
            {terminal.paymentMethods?.length ? <div style={{ display: "grid", gap: 5, marginTop: 10 }}>
              {terminal.paymentMethods.map((method, index) => <div key={method.type + "-" + index} style={{ fontSize: 13 }}>
                <b>{method.type === "dedicated_nuban" ? "Dedicated bank account" : method.type ?? "Payment method"}:</b> {method.account_number ?? "Details not supplied"} {method.bank ? "· " + method.bank : ""} {method.account_name ? "· " + method.account_name : ""}
              </div>)}
            </div> : <p style={{ fontSize: 13, margin: "8px 0" }}>No payment-method details were returned by Paystack.</p>}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
              <input aria-label={"New name for " + terminal.code} value={rename[terminal.code] ?? terminal.name} onChange={e => setRename(current => ({ ...current, [terminal.code]: e.target.value }))} maxLength={80} disabled={busy || !terminal.active} style={{ flex: "1 1 190px" }}/>
              <button type="button" className="fp-admin-refresh" onClick={() => void updateName(terminal)} disabled={busy || !terminal.active || (rename[terminal.code] ?? terminal.name).trim().length < 2}>Save name</button>
              {terminal.active && <button type="button" className="fp-admin-refresh" onClick={() => void deactivate(terminal)} disabled={busy}><XCircle size={15}/> Deactivate</button>}
            </div>
          </article>)}
        </div>}
      <p style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12, marginTop: 14 }}><ShieldCheck size={15}/> Only verified Super Admin accounts can manage terminals. Creation and deactivation are sent to Paystack only when an administrator confirms the action.</p>
    </section>
  );
}
