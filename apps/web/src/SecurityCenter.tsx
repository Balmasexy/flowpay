import { useCallback, useEffect, useState } from "react";
import { Clock3, KeyRound, RefreshCw, ShieldCheck, Smartphone } from "lucide-react";

type Passkey = {
  name: string;
  deviceType: string | null;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
};
type SecurityEvent = { type: string; outcome: string; createdAt: string };
type SecurityData = {
  passkeys: Passkey[];
  recentEvents: SecurityEvent[];
  capabilities: {
    passkeyRegistrationEnabled: boolean;
    passwordChangeEnabled: boolean;
    twoStepVerificationEnabled: boolean;
    sessionRevocationEnabled: boolean;
    transactionPinEnabled: boolean;
  };
  message: string;
};

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/+$/, "") || "";
function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleString();
}
function label(value: string) {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, letter => letter.toUpperCase());
}

export default function SecurityCenter({ token }: { token: string }) {
  const [data, setData] = useState<SecurityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!token || token.split(".").length !== 3) {
      setError("Your secure session is unavailable. Sign in again to view account security.");
      setData(null); setLoading(false); return;
    }
    if (!API_BASE) { setError("FlowPay API address is not configured."); setLoading(false); return; }
    setLoading(true); setError("");
    try {
      const response = await fetch(API_BASE + "/customer/security", {
        method: "GET", credentials: "omit", headers: { Authorization: "Bearer " + token }
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Unable to load security information.");
      setData(body as SecurityData);
    } catch (cause) {
      setData(null);
      setError(cause instanceof Error ? cause.message : "Unable to load security information.");
    } finally { setLoading(false); }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  const disabled = data?.capabilities;
  return <section className="fp-panel fp-detail-panel">
    <div className="fp-profile-heading">
      <div><span className="fp-profile-kicker">ACCOUNT PROTECTION</span><h2>Security centre</h2><p className="fp-muted">Review security records linked to your authenticated FlowPay account.</p></div>
      <button className="fp-outline" type="button" onClick={() => void load()} disabled={loading}><RefreshCw size={15}/> Refresh</button>
    </div>
    {loading && <p className="fp-muted" role="status">Loading your security records…</p>}
    {error && <div className="fp-preview-warning" role="alert">{error} <button className="fp-overview-link" onClick={() => void load()}>Try again</button></div>}
    {data && <>
      <div className="fp-feature-list">
        <div><KeyRound size={18}/> Passkeys registered <b>{data.passkeys.length}</b></div>
        <div><ShieldCheck size={18}/> Two-step verification <b>{disabled?.twoStepVerificationEnabled ? "Enabled" : "Not enabled"}</b></div>
        <div><Smartphone size={18}/> Trusted-device management <b>{disabled?.sessionRevocationEnabled ? "Available" : "Unavailable"}</b></div>
      </div>
      <div className="fp-profile-section-title"><h3>Your registered passkeys</h3><span>Read-only security records</span></div>
      {data.passkeys.length ? <div className="fp-doc-list">{data.passkeys.map((item, index) => <div key={item.name + item.createdAt + index}>
        <KeyRound size={18}/><span>{item.name}<small>{item.deviceType ? label(item.deviceType) : "Device type not recorded"} · {item.backedUp ? "Backed up" : "Not backed up"} · Added {dateLabel(item.createdAt)}</small></span><b>{item.lastUsedAt ? "Used " + dateLabel(item.lastUsedAt) : "Not yet used"}</b>
      </div>)}</div> : <div className="fp-empty"><KeyRound size={23}/><b>No passkeys registered</b><span>Passkey enrollment is not yet available in FlowPay. No phone biometric or passkey enrollment is being assumed.</span></div>}
      <div className="fp-profile-section-title"><h3>Recent security activity</h3><span>Latest recorded events</span></div>
      {data.recentEvents.length ? <div className="fp-doc-list">{data.recentEvents.map((event,index)=><div key={event.type+event.createdAt+index}>
        <Clock3 size={18}/><span>{label(event.type)}<small>{dateLabel(event.createdAt)}</small></span><b>{label(event.outcome)}</b>
      </div>)}</div> : <div className="fp-empty"><Clock3 size={23}/><b>No security events recorded</b><span>New security events will appear here when supported account-security actions are implemented.</span></div>}
      <div className="fp-preview-warning"><ShieldCheck size={17}/> {data.message} Password changes, passkey enrollment, 2-step verification, session revocation and transaction PIN changes are currently unavailable.</div>
    </>}
  </section>;
}
