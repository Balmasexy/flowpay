import { useEffect, useState, type FormEvent } from "react";
import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import {
  ArrowLeft,
  ArrowRight,
  Eye,
  EyeOff,
  Fingerprint,
  KeyRound,
  LockKeyhole,
  MailCheck,
  ShieldCheck
} from "lucide-react";
import { authClient, authConfigured, clearFlowPayPasskeySession, requestPasswordRecoveryCode, resetPasswordWithRecoveryCode, saveFlowPayPasskeySession } from "./auth-client";

type LoginScreen = "login" | "forgot-email" | "forgot-code";
const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") || "";

export default function LoginPage() {
  const [screen, setScreen] = useState<LoginScreen>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const normalizedEmail = email.trim().toLowerCase();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("oauth") === "error" || params.has("error")) {
      setError("Google sign-in could not be completed. Please try again or use your email and password.");
    }
  }, []);

  function clearFeedback() {
    setError("");
    setNotice("");
  }

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clearFeedback();

    if (!authConfigured) {
      setError("Sign-in is not configured yet. Please try again later.");
      return;
    }
    if (!normalizedEmail || !password) {
      setError("Enter your email address and password to continue.");
      return;
    }

    setBusy(true);
    try {
      // Normal FlowPay login uses the account password. Email OTP is only
      // used in the explicit password-recovery flow below.
      clearFlowPayPasskeySession();
      const result = await authClient.signIn.email({
        email: normalizedEmail,
        password
      });
      if (result.error) {
        setError("We could not sign you in. Check your email and password. If you created this account with Google, use Forgot password to set a password for email sign-in.");
        return;
      }
      window.location.assign("/dashboard");
    } catch (cause) {
      setError(cause instanceof Error && cause.message !== "Failed to fetch"
        ? cause.message
        : "FlowPay could not reach the sign-in service. Check your connection and try again. Your credentials have not been verified.");
    } finally {
      setBusy(false);
    }
  }

  async function signInWithGoogle() {
    clearFeedback();

    if (!authConfigured) {
      setError("Google sign-in is not configured on this deployment. Please try again later.");
      return;
    }

    setBusy(true);
    try {
      clearFlowPayPasskeySession();
      const result = await authClient.signIn.social({
        provider: "google",
        callbackURL: "/dashboard",
        errorCallbackURL: "/login?oauth=error"
      });

      if (result.error) {
        setError(result.error.message || "Google sign-in was declined. Please try again.");
      }
    } catch (cause) {
      setError(cause instanceof Error && cause.message !== "Failed to fetch"
        ? cause.message
        : "FlowPay could not reach Google sign-in. Check your connection and try again, or use your password.");
    } finally {
      setBusy(false);
    }
  }

  async function signInWithPasskey() {
    clearFeedback();

    if (!normalizedEmail) {
      setError("Enter the Gmail address registered to your FlowPay account first.");
      return;
    }
    if (!API_BASE) {
      setError("FlowPay API address is not configured. Please try again later.");
      return;
    }
    if (!browserSupportsWebAuthn()) {
      setError("This browser does not support device passkeys. Use Google or your email and password.");
      return;
    }

    setBusy(true);
    clearFlowPayPasskeySession();
    try {
      const optionsResponse = await fetch(API_BASE + "/auth/passkeys/authentication/options", {
        method: "POST",
        credentials: "omit",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ email: normalizedEmail })
      });
      const optionsBody: unknown = await optionsResponse.json().catch(() => null);
      const optionsRecord = optionsBody && typeof optionsBody === "object"
        ? optionsBody as Record<string, unknown>
        : {};
      if (!optionsResponse.ok || typeof optionsRecord.challengeId !== "string" || !optionsRecord.options) {
        const errorCode = typeof optionsRecord.error === "string" ? optionsRecord.error : "";
        if (errorCode === "PASSKEY_NOT_AVAILABLE_FOR_ACCOUNT") {
          throw new Error("No device passkey is registered for this email yet. Sign in with Google or your password, then register this phone in Security.");
        }
        throw new Error(typeof optionsRecord.message === "string" ? optionsRecord.message : "Unable to start fingerprint sign-in. Try your password or Google.");
      }

      const assertion = await startAuthentication({
        optionsJSON: optionsRecord.options as never
      });
      const verifyResponse = await fetch(API_BASE + "/auth/passkeys/authentication/verify", {
        method: "POST",
        credentials: "omit",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          email: normalizedEmail,
          challengeId: optionsRecord.challengeId,
          response: assertion
        })
      });
      const verifiedBody: unknown = await verifyResponse.json().catch(() => null);
      if (!verifyResponse.ok) {
        const errorCode = verifiedBody && typeof verifiedBody === "object" && "error" in verifiedBody
          ? String((verifiedBody as Record<string, unknown>).error)
          : "";
        throw new Error(errorCode === "PASSKEY_AUTHENTICATION_FAILED"
          ? "Device verification did not match a registered FlowPay passkey. Try again or use your password."
          : "FlowPay could not verify this device passkey. Please try again.");
      }
      saveFlowPayPasskeySession(verifiedBody);
      window.location.assign("/dashboard");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Unable to sign in with your device passkey.";
      setError(message.includes("NotAllowedError") || message.toLowerCase().includes("cancel")
        ? "Device verification was cancelled. Try again when your fingerprint or device PIN is ready."
        : message);
    } finally {
      setBusy(false);
    }
  }

  async function sendRecoveryCode() {
    clearFeedback();

    if (!authConfigured) {
      setError("Password recovery is not configured yet. Please try again later.");
      return;
    }
    if (!normalizedEmail) {
      setError("Enter the email address registered to your FlowPay account.");
      return;
    }

    setBusy(true);
    try {
      const result = await requestPasswordRecoveryCode(normalizedEmail);
      if (result.error) {
        setError(result.error.message || "We could not send a recovery code. Please try again.");
        return;
      }
      setCode("");
      setNewPassword("");
      setConfirmPassword("");
      setScreen("forgot-code");
      setNotice("A six-digit password recovery code has been sent. Check your inbox and spam folder.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to send a password recovery code.");
    } finally {
      setBusy(false);
    }
  }

  async function requestPasswordReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await sendRecoveryCode();
  }

  async function resetPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clearFeedback();

    if (code.length !== 6 || [...code].some(char => char < "0" || char > "9")) {
      setError("Enter the six-digit recovery code sent to your email.");
      return;
    }
    if (newPassword.length < 8) {
      setError("Your new password must contain at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("The new passwords do not match.");
      return;
    }

    setBusy(true);
    try {
      const result = await resetPasswordWithRecoveryCode(
normalizedEmail, code, newPassword);
      if (result.error) {
        setError(result.error.message || "The recovery code is invalid or expired. Request a new code.");
        return;
      }

      setPassword("");
      setCode("");
      setNewPassword("");
      setConfirmPassword("");
      setScreen("login");
      setNotice("Your password has been reset. Sign in with your new password.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to reset your password.");
    } finally {
      setBusy(false);
    }
  }

  function backToLogin() {
    clearFeedback();
    setCode("");
    setNewPassword("");
    setConfirmPassword("");
    setScreen("login");
  }

  const isLogin = screen === "login";
  const isRecovery = screen === "forgot-email";
  const title = isLogin ? "Welcome back" : isRecovery ? "Forgot password?" : "Create a new password";
  const subtitle = isLogin
    ? "Log in to your FlowPay account"
    : isRecovery
      ? "Enter your registered email and we'll send you a secure recovery code."
      : <>Enter the six-digit code sent to <strong>{normalizedEmail}</strong> and choose a new password.</>;

  return (
    <main className="fp-login-opay-page">
      <header className="fp-login-opay-topbar">
        <a className="fp-login-opay-brand" href="/" aria-label="FlowPay home">
          <span className="fp-login-opay-brand-mark">F</span>
          <span>Flow<span>Pay</span></span>
        </a>
        <a className="fp-login-opay-help" href="mailto:support@flowpay.ng">Help & support</a>
      </header>

      <section className="fp-login-opay-card" aria-labelledby="fp-login-title">
        <div className="fp-login-opay-intro">
          <div className="fp-login-opay-icon">
            {isLogin ? <LockKeyhole size={23}/> : screen === "forgot-code" ? <MailCheck size={23}/> : <KeyRound size={23}/>}
          </div>
          <span className="fp-login-opay-eyebrow">FLOWPAY ACCOUNT</span>
          <h1 id="fp-login-title">{title}</h1>
          <p>{subtitle}</p>
        </div>

        {isLogin && (
          <form className="fp-login-opay-form" onSubmit={signIn}>
            <label htmlFor="fp-login-email">Email address</label>
            <input
              id="fp-login-email"
              type="email"
              autoComplete="username"
              inputMode="email"
              maxLength={254}
              placeholder="Enter your email address"
              value={email}
              onChange={event => setEmail(event.target.value)}
              required
            />

            <div className="fp-login-opay-label-row">
              <label htmlFor="fp-login-password">Password</label>
              <button
                type="button"
                className="fp-login-opay-text-button"
                onClick={() => { clearFeedback(); setScreen("forgot-email"); }}
              >
                Forgot password?
              </button>
            </div>
            <div className="fp-login-opay-password">
              <input
                id="fp-login-password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                maxLength={128}
                placeholder="Enter your password"
                value={password}
                onChange={event => setPassword(event.target.value)}
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword(value => !value)}
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? <EyeOff size={18}/> : <Eye size={18}/>}
              </button>
            </div>

            {error && <div className="fp-login-opay-alert" role="alert">{error}</div>}
            {notice && <div className="fp-login-opay-success" role="status">{notice}</div>}
            {!authConfigured && <div className="fp-login-opay-alert" role="status">Authentication is not configured on this deployment. No credentials will be sent.</div>}

            <button className="fp-login-opay-submit" type="submit" disabled={busy || !authConfigured}>
              {busy ? "Signing in…" : "Log in"} <ArrowRight size={17}/>
            </button>
          </form>
        )}

        {isRecovery && (
          <form className="fp-login-opay-form" onSubmit={requestPasswordReset}>
            <label htmlFor="fp-recovery-email">Email address</label>
            <input
              id="fp-recovery-email"
              type="email"
              autoComplete="email"
              inputMode="email"
              maxLength={254}
              placeholder="Enter your registered email"
              value={email}
              onChange={event => setEmail(event.target.value)}
              required
            />
            {error && <div className="fp-login-opay-alert" role="alert">{error}</div>}
            {!authConfigured && <div className="fp-login-opay-alert" role="status">Password recovery is not configured on this deployment.</div>}
            <button className="fp-login-opay-submit" type="submit" disabled={busy || !authConfigured}>
              {busy ? "Sending code…" : "Send recovery code"} <ArrowRight size={17}/>
            </button>
            <button className="fp-login-opay-back" type="button" onClick={backToLogin} disabled={busy}>
              <ArrowLeft size={16}/> Back to log in
            </button>
          </form>
        )}

        {screen === "forgot-code" && (
          <form className="fp-login-opay-form" onSubmit={resetPassword}>
            <label htmlFor="fp-recovery-code">Six-digit recovery code</label>
            <input
              id="fp-recovery-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              placeholder="Enter code"
              value={code}
              onChange={event => setCode(Array.from(event.target.value).filter(char => char >= "0" && char <= "9").join("").slice(0, 6))}
              required
            />

            <label htmlFor="fp-new-password">New password</label>
            <input
              id="fp-new-password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              maxLength={128}
              placeholder="At least 8 characters"
              value={newPassword}
              onChange={event => setNewPassword(event.target.value)}
              required
            />

            <label htmlFor="fp-confirm-password">Confirm new password</label>
            <input
              id="fp-confirm-password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              maxLength={128}
              placeholder="Enter your new password again"
              value={confirmPassword}
              onChange={event => setConfirmPassword(event.target.value)}
              required
            />

            {error && <div className="fp-login-opay-alert" role="alert">{error}</div>}
            {notice && <div className="fp-login-opay-success" role="status">{notice}</div>}
            <button
              className="fp-login-opay-submit"
              type="submit"
              disabled={busy || code.length !== 6 || newPassword.length < 8 || newPassword !== confirmPassword}
            >
              {busy ? "Updating password…" : "Reset password"} <ArrowRight size={17}/>
            </button>
            <button
              className="fp-login-opay-back"
              type="button"
              onClick={() => void sendRecoveryCode()}
              disabled={busy}
            >
              Resend recovery code
            </button>
            <button className="fp-login-opay-back" type="button" onClick={backToLogin} disabled={busy}>
              <ArrowLeft size={16}/> Back to log in
            </button>
          </form>
        )}

        {isLogin && (
          <div className="fp-login-opay-alternatives">
            <div className="fp-login-opay-divider"><span>OR</span></div>
            <button
              className="fp-login-opay-google"
              type="button"
              onClick={() => void signInWithGoogle()}
              disabled={busy || !authConfigured}
            >
              <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">
                <path fill="#FFC107" d="M43.6 24.5c0-1.4-.1-2.8-.4-4.1H24v7.8h11a9.4 9.4 0 0 1-4.1 6.2v5.1h6.6c3.9-3.6 6.1-8.8 6.1-15Z"/>
                <path fill="#34A853" d="M24 44c5.5 0 10.1-1.8 13.5-4.9l-6.6-5.1c-1.8 1.2-4.1 1.9-6.9 1.9-5.3 0-9.8-3.6-11.4-8.4H5.8v5.2A20 20 0 0 0 24 44Z"/>
                <path fill="#4A90E2" d="M12.6 27.5a12 12 0 0 1 0-7V15.3H5.8a20 20 0 0 0 0 17.4l6.8-5.2Z"/>
                <path fill="#EA4335" d="M24 12.1c3 0 5.7 1 7.8 3.1l5.9-5.9A19.7 19.7 0 0 0 24 4 20 20 0 0 0 5.8 15.3l6.8 5.2c1.6-4.8 6.1-8.4 11.4-8.4Z"/>
              </svg>
              <span>Continue with Google</span>
            </button>
            <button
              className="fp-login-opay-passkey"
              type="button"
              onClick={() => void signInWithPasskey()}
              disabled={busy || !API_BASE}
              title="Use a passkey registered to this FlowPay account on this device."
            >
              <Fingerprint size={21}/>
              <span>Sign in with fingerprint / passkey</span>
              <span className="fp-login-opay-passkey-status">{busy ? "Verifying…" : "Device secure"}</span>
            </button>
            <p className="fp-login-opay-passkey-note">
              Enter your registered email above, then confirm with your phone's fingerprint, face, or secure screen-lock prompt. Register this device once in Security after signing in.
            </p>
          </div>
        )}

        {isLogin && (
          <p className="fp-login-opay-signup">
            New to FlowPay? <a href="/signup">Create an account</a>
          </p>
        )}

        {!isLogin && screen === "forgot-code" && (
          <p className="fp-login-opay-signup">
            Wrong email address? <button type="button" onClick={() => { clearFeedback(); setScreen("forgot-email"); }}>Change email</button>
          </p>
        )}

        <div className="fp-login-opay-security">
          <ShieldCheck size={17}/>
          <span>Your account is protected. Never share your password or recovery code with anyone.</span>
        </div>
      </section>

      <footer className="fp-login-opay-footer">
        <span>© {new Date().getFullYear()} FlowPay</span>
        <span><LockKeyhole size={13}/> Secure account access</span>
      </footer>
    </main>
  );
}
