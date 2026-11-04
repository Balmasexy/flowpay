import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, CheckCircle2, Clock3, RefreshCw, ShieldAlert, ShieldCheck, XCircle } from "lucide-react";

type VerificationStatus = "not_started" | "pending" | "under_review" | "verified" | "rejected" | "failed";
type Props = { token: string };
type StatusResponse = {
  configured?: boolean;
  verificationEnabled?: boolean;
  status?: VerificationStatus;
  resultText?: string | null;
  resultCode?: string | null;
  checks?: { liveness?: string | null; selfie?: string | null; selfieProvided?: string | null; registerSelfie?: string | null; humanReviewLiveness?: string | null; humanReviewSelfie?: string | null };
  updatedAt?: string | null;
  verifiedAt?: string | null;
};
type CapturedPayload = {
  images?: Array<{ image_type_id: number | string; image: string }>;
  partner_params?: { libraryVersion?: string };
};

const API_BASE = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "").replace(/\/$/, "");
const CAMERA_SDK_URL = "https://cdn.smileidentity.com/js/v11.0.1/smart-camera-web.js";

export default function FaceVerification({ token }: Props) {
  const [status, setStatus] = useState<StatusResponse>({});
  const [loading, setLoading] = useState(true);
  const [consent, setConsent] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraLoading, setCameraLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const cameraMount = useRef<HTMLDivElement>(null);
  const cameraElement = useRef<HTMLElement | null>(null);

  const refreshStatus = useCallback(async () => {
    if (!API_BASE || !token) {
      setError("The FlowPay API connection or your sign-in session is unavailable.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await fetch(API_BASE + "/customer/face-verification", {
        method: "GET",
        credentials: "omit",
        headers: { Authorization: "Bearer " + token }
      });
      const data = await response.json() as StatusResponse & { error?: string; message?: string };
      if (!response.ok) throw new Error(data.message || data.error || "Unable to load face verification status.");
      setStatus(data);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load face verification status.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { void refreshStatus(); }, [refreshStatus]);

  const stopCamera = useCallback(() => {
    cameraElement.current?.remove();
    cameraElement.current = null;
    setCameraOpen(false);
    setCameraLoading(false);
  }, []);

  useEffect(() => () => {
    cameraElement.current?.remove();
    cameraElement.current = null;
  }, []);

  const handleCapture = useCallback(async (event: Event) => {
    const detail = (event as CustomEvent<CapturedPayload>).detail;
    if (!detail || !Array.isArray(detail.images) || detail.images.length < 2) {
      setError("The camera did not return the required selfie and liveness frames. Please try again.");
      stopCamera();
      return;
    }
    setSubmitting(true);
    setError("");
    setNotice("Securely submitting your capture to Smile ID sandbox. FlowPay does not save the raw images.");
    try {
      const response = await fetch(API_BASE + "/customer/face-verification", {
        method: "POST",
        credentials: "omit",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({
          consentGiven: true,
          images: detail.images,
          partner_params: { libraryVersion: detail.partner_params?.libraryVersion }
        })
      });
      const data = await response.json() as { message?: string; error?: string };
      if (!response.ok) throw new Error(data.message || data.error || "Smile ID did not accept the capture.");
      setNotice(data.message || "Capture submitted. Final status updates after Smile ID completes its checks.");
      setConsent(false);
      await refreshStatus();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to submit your face verification.");
      setNotice("");
    } finally {
      setSubmitting(false);
      stopCamera();
    }
  }, [refreshStatus, stopCamera, token]);

  const startCamera = async () => {
    setError("");
    setNotice("");
    if (!consent) {
      setError("Please read and accept the face and liveness verification consent before opening the camera.");
      return;
    }
    if (!status.verificationEnabled || !status.configured) {
      setError("Smile ID sandbox, database migration, and customer authentication must be ready before capture can start.");
      return;
    }
    if (!window.isSecureContext) {
      setError("Camera access requires a secure HTTPS connection. Open FlowPay using its HTTPS address.");
      return;
    }
    setCameraLoading(true);
    try {
      let script = document.querySelector<HTMLScriptElement>("script[data-flowpay-smile-camera]");
      if (!customElements.get("smart-camera-web") && !script) {
        script = document.createElement("script");
        script.src = CAMERA_SDK_URL;
        script.async = true;
        script.dataset.flowpaySmileCamera = "true";
        document.head.appendChild(script);
      }
      if (!customElements.get("smart-camera-web")) {
        await new Promise<void>((resolve, reject) => {
          const timeout = window.setTimeout(() => reject(new Error("Smile ID camera SDK did not finish loading. Check your internet connection and retry.")), 20000);
          script?.addEventListener("load", () => { window.clearTimeout(timeout); resolve(); }, { once: true });
          script?.addEventListener("error", () => { window.clearTimeout(timeout); reject(new Error("Unable to load the Smile ID camera SDK.")); }, { once: true });
        });
      }
      await customElements.whenDefined("smart-camera-web");
      const host = cameraMount.current;
      if (!host) throw new Error("Camera panel is not available.");
      host.replaceChildren();
      const element = document.createElement("smart-camera-web");
      element.style.display = "block";
      element.style.width = "100%";
      element.addEventListener("imagesComputed", handleCapture, { once: true });
      cameraElement.current = element;
      host.appendChild(element);
      setCameraOpen(true);
      setNotice("Allow camera access, keep your face inside the guide, and complete every on-screen liveness prompt.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to start the verification camera.");
      setCameraOpen(false);
    } finally {
      setCameraLoading(false);
    }
  };

  const statusLabel = status.status === "verified" ? "Face verified" :
    status.status === "under_review" ? "Under review" :
    status.status === "pending" ? "Verification pending" :
    status.status === "rejected" ? "Verification rejected" :
    status.status === "failed" ? "Verification failed" : "Not yet verified";
  const statusIcon = status.status === "verified" ? <CheckCircle2 size={20}/> :
    status.status === "under_review" || status.status === "pending" ? <Clock3 size={20}/> :
    status.status === "rejected" || status.status === "failed" ? <XCircle size={20}/> : <ShieldCheck size={20}/>;

  return <section className="fp-panel fp-detail-panel">
    <div style={{ display: "flex", justifyContent: "space-between", gap: 14, flexWrap: "wrap", alignItems: "flex-start" }}>
      <div>
        <h2>Face & liveness verification</h2>
        <p className="fp-muted">Confirm that you are a real person using a live selfie capture—not a profile photo upload.</p>
      </div>
      <button type="button" className="fp-outline" onClick={() => void refreshStatus()} disabled={loading || submitting}>
        <RefreshCw size={16}/> Refresh status
      </button>
    </div>

    <div style={{ marginTop: 18, padding: 16, border: "1px solid var(--fp-border, #d8dee8)", borderRadius: 14, display: "flex", gap: 12, alignItems: "center" }}>
      <span style={{ color: status.status === "verified" ? "#16a34a" : status.status === "rejected" || status.status === "failed" ? "#dc2626" : "#ff7a18" }}>{statusIcon}</span>
      <div style={{ flex: 1 }}>
        <b>{loading ? "Loading verification status…" : statusLabel}</b>
        <div className="fp-muted" style={{ fontSize: 13, marginTop: 4 }}>
          {status.verifiedAt ? "Verified " + new Date(status.verifiedAt).toLocaleString() :
            status.updatedAt ? "Last updated " + new Date(status.updatedAt).toLocaleString() :
            "No completed verification has been recorded."}
        </div>
        {status.resultText && <div className="fp-muted" style={{ fontSize: 13, marginTop: 4 }}>{status.resultText}</div>}
      </div>
    </div>

    {status.checks && (status.checks.liveness || status.checks.selfie || status.checks.selfieProvided) && <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginTop: 12 }}>
      {[["Liveness", status.checks.liveness], ["Selfie check", status.checks.selfie], ["Selfie received", status.checks.selfieProvided], ["Registration", status.checks.registerSelfie], ["Human liveness review", status.checks.humanReviewLiveness], ["Human selfie review", status.checks.humanReviewSelfie]].filter((item) => item[1]).map(([label, value]) =>
        <div key={label} style={{ border: "1px solid var(--fp-border, #d8dee8)", borderRadius: 10, padding: 11 }}>
          <small className="fp-muted">{label}</small><div style={{ fontWeight: 650, marginTop: 5 }}>{value}</div>
        </div>
      )}
    </div>}

    {error && <div className="fp-preview-warning" role="alert" style={{ marginTop: 14 }}><ShieldAlert size={17}/>{error}</div>}
    {notice && <div className="fp-preview-warning" role="status" style={{ marginTop: 14 }}><Camera size={17}/>{notice}</div>}

    {!status.configured && <div className="fp-preview-warning" style={{ marginTop: 14 }}>
      <ShieldAlert size={17}/> Smile ID sandbox credentials and the HTTPS callback endpoint must be configured on the FlowPay API, and migration 011 must be applied before capture. Production verification remains disabled.
    </div>}

    {status.status !== "verified" && !cameraOpen && <div style={{ marginTop: 18 }}>
      <label style={{ display: "flex", alignItems: "flex-start", gap: 10, lineHeight: 1.5, fontSize: 13 }}>
        <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} disabled={!status.verificationEnabled || submitting}/>
        <span>I consent to FlowPay capturing my selfie and liveness frames and sending them securely to Smile ID for sandbox verification. This is separate from my profile photo. FlowPay will store verification result metadata and consent time, not the raw selfie/video frames.</span>
      </label>
      <button type="button" className="fp-primary" onClick={() => void startCamera()} disabled={!status.verificationEnabled || !consent || cameraLoading || submitting} style={{ marginTop: 16 }}>
        <Camera size={17}/> {cameraLoading ? "Opening secure camera…" : status.status === "rejected" || status.status === "failed" ? "Try verification again" : "Start face verification"}
      </button>
    </div>}

    <div style={{ display: cameraOpen ? "block" : "none", marginTop: 18, border: "1px solid var(--fp-border, #d8dee8)", borderRadius: 14, padding: 12 }}>
      <div ref={cameraMount}/>
      {cameraOpen && <button type="button" className="fp-outline" onClick={stopCamera} disabled={submitting} style={{ marginTop: 12 }}>Cancel camera</button>}
    </div>

    {submitting && <p className="fp-muted" style={{ marginTop: 14 }}>Submitting securely. Do not close this page until the submission finishes.</p>}
    <div className="fp-preview-warning" style={{ marginTop: 18 }}>
      <ShieldCheck size={17}/> Verification passes only when Smile ID confirms an approved result and the liveness, selfie, and selfie-provided checks pass. Pending or inconclusive checks are never treated as verified. This feature does not change balances, transaction history, or transfer/payment permissions.
    </div>
  </section>;
}