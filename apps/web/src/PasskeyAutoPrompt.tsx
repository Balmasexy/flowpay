import { useEffect, useState } from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import { KeyRound, ShieldCheck } from "lucide-react";

type Props = { apiUrl: string; getAccessToken: () => Promise<string | null> };
type ApiOptions = { ceremonyId: string; options: Record<string, unknown> };

export default function PasskeyAutoPrompt({ apiUrl, getAccessToken }: Props) {
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const token = await getAccessToken();
    if (!token) throw new Error("Your FlowPay sign-in session is unavailable. Sign in again.");
    const response = await fetch(`${apiUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      cache: "no-store",
      signal: AbortSignal.timeout(10000)
    });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(typeof data.message === "string" ? data.message : typeof data.error === "string" ? data.error : `Request failed (${response.status})`);
    return data as T;
  }

  useEffect(() => {
    let active = true;
    void request<{ passkeys: unknown[] }>("/v1/me/passkeys")
      .then((result) => { if (active) setAvailable(result.passkeys.length > 0); })
      .catch(() => { if (active) setAvailable(false); });
    return () => { active = false; };
  }, []);

  async function verify() {
    setBusy(true);
    setMessage("Waiting for your device passkey…");
    try {
      const start = await request<ApiOptions>("/v1/me/passkeys/auth/options", "POST", {});
      const response = await startAuthentication({ optionsJSON: start.options as never });
      const result = await request<{ verified: boolean; message?: string }>("/v1/me/passkeys/auth/verify", "POST", { ceremonyId: start.ceremonyId, response });
      setMessage(result.verified ? "Passkey verified for this signed-in session. Financial actions remain separately protected." : "Passkey verification was not accepted.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Passkey verification could not be completed.");
    } finally { setBusy(false); }
  }

  if (!available) return null;
  return (
    <section className="notice" aria-live="polite">
      <div className="notice-icon"><KeyRound size={21} /></div>
      <div>
        <strong>Registered passkey detected</strong>
        <p>{message || "A passkey is already registered to this FlowPay account. Verify with your device when you are ready."}</p>
      </div>
      <button className="feature-button" type="button" onClick={() => void verify()} disabled={busy}>
        <ShieldCheck size={17} /> {busy ? "Verifying…" : "Verify passkey"}
      </button>
    </section>
  );
}
