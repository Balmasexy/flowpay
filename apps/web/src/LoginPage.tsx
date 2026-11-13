import { useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, KeyRound, LockKeyhole, MailCheck, ShieldCheck } from "lucide-react";
import { authClient, authConfigured } from "./auth-client";

type Step = "sign-in-email" | "sign-in-code" | "forgot-email" | "forgot-code";

export default function LoginPage() {
  const [step, setStep] = useState<Step>("sign-in-email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  function clearFeedback() {
    setMessage("");
    setError("");
  }

  async function sendSignInCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clearFeedback();
    if (!authConfigured) {
      setError("Sign-in is not configured on this deployment yet. Please try again later.");
      return;
    }
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) {
      setError("Enter the email address registered to your FlowPay account.");
      return;
    }
    setBusy(true);
    try {
      const result = await authClient.emailOtp.sendVerificationOtp({
        email: normalizedEmail,
        type: "sign-in"
      });
      if (result.error) {
        setError(result.error.message || "We could not send a sign-in code. Check the email address and try again.");
        return;
      }
      setEmail(normalizedEmail);
      setCode("");
      setStep("sign-in-code");
      setMessage("A six-digit sign-in code has been sent. Check your inbox and spam folder.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to send a sign-in code. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function verifySignInCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clearFeedback();
    if (!/^\d{6}$/.test(code)) {
      setError("Enter the six-digit code sent to your email.");
      return;
    }
    setBusy(true);
    try {
      const result = await authClient.signIn.emailOtp({
        email: email.trim().toLowerCase(),
        otp: code
      });
      if (result.error) {
        setError(result.error.message || "That code is invalid or expired. Request a new code and try again.");
        return;
      }
      window.location.assign("/dashboard");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to verify your sign-in code.");
    } finally {
      setBusy(false);
    }
  }

  async function sendPasswordResetCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clearFeedback();
    if (!authConfigured) {
      setError("Password recovery is not configured on this deployment yet.");
      return;
    }
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) {
      setError("Enter the email address registered to your FlowPay account.");
      return;
    }
    setBusy(true);
    try {
      const result = await authClient.forgetPassword.emailOtp({ email: normalizedEmail });
      if (result.error) {
        setError(result.error.message || "We could not start password recovery. Please try again shortly.");
        return;
      }
      setEmail(normalizedEmail);
      setCode("");
      setNewPassword("");
      setConfirmPassword("");
      setStep("forgot-code");
      setMessage("A six-digit password recovery code has been requested. Check your inbox and spam folder.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to send a password recovery code.");
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clearFeedback();
    if (!/^\d{6}$/.test(code)) {
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
      const result = await authClient.emailOtp.resetPassword({
        email: email.trim().toLowerCase(),
        otp: code,
        password: newPassword
      });
      if (result.error) {
        setError(result.error.message || "The recovery code could not be verified. Request a new code and try again.");
        return;
      }
      setCode("");
      setNewPassword("");
      setConfirmPassword("");
      setStep("sign-in-email");
      setMessage("Your password has been changed. Sign in using a fresh email verification code.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to reset your password.");
    } finally {
      setBusy(false);
    }
  }

  function startForgotPassword() {
    clearFeedback();
    if (email.trim()) {
      setStep("forgot-email");
      return;
    }
    setStep("forgot-email");
  }

  function backToSignIn() {
    clearFeedback();
    setCode("");
    setNewPassword("");
    setConfirmPassword("");
    setStep("sign-in-email");
  }

  const title = step === "sign-in-code" ? "Enter your sign-in code"
    : step === "forgot-email" ? "Recover your password"
    : step === "forgot-code" ? "Reset your password"
    : "Log in";
  const subtitle = step === "sign-in-code"
    ? <>Enter the six-digit code sent to <strong>{email}</strong>.</>
    : step === "forgot-email"
      ? "Enter your FlowPay email address and we will send a password recovery code."
      : step === "forgot-code"
        ? <>Enter the recovery code sent to <strong>{email}</strong>, then choose a new password.</>
        : "Enter your email address to receive a secure sign-in code.";

  return <main className="fp-login-page">
    <a className="fp-login-back" href="/"><ArrowLeft size={16}/> Back to FlowPay</a>
    <section className="fp-login-shell">
      <div className="fp-login-aside">
        <a className="fp-public-brand" href="/"><span className="fp-public-logo">F</span>Flow<span>Pay</span></a>
        <div><span>WELCOME BACK</span><h1>Your financial life,<br/><em>in one place.</em></h1><p>Sign in securely to access your FlowPay account, services and security settings.</p></div>
        <div className="fp-login-assurance"><ShieldCheck size={18}/> Your account access is protected by email verification.</div>
      </div>
      <div className="fp-login-form-wrap">
        <div className="fp-login-icon">{step === "sign-in-code" || step === "forgot-code" ? <MailCheck size={23}/> : <LockKeyhole size={23}/>}</div>
        <span className="fp-login-eyebrow">FLOWPAY ACCOUNT</span>
        <h2>{title}</h2>
        <p className="fp-login-subtitle">{subtitle}</p>

        {step === "sign-in-email" && <form onSubmit={sendSignInCode}>
          <label htmlFor="fp-login-email">Email address</label>
          <input id="fp-login-email" type="email" autoComplete="email" required maxLength={254}
            placeholder="you@example.com" value={email} onChange={event => setEmail(event.target.value)}/>
          {error && <div className="fp-login-notice" role="alert"><ShieldCheck size={17}/><span>{error}</span></div>}
          {message && <div className="fp-login-notice" role="status"><ShieldCheck size={17}/><span>{message}</span></div>}
          {!authConfigured && <div className="fp-login-notice" role="status"><ShieldCheck size={17}/><span>Authentication is not configured on this deployment. No credentials will be sent.</span></div>}
          <button className="fp-login-submit" type="submit" disabled={busy || !authConfigured}>
            {busy ? "Sending verification code…" : "Send sign-in code"} <ArrowRight size={16}/>
          </button>
        </form>}

        {step === "sign-in-code" && <form onSubmit={verifySignInCode}>
          <label htmlFor="fp-login-code">Six-digit verification code</label>
          <input id="fp-login-code" type="text" inputMode="numeric" autoComplete="one-time-code"
            pattern="[0-9]{6}" maxLength={6} required placeholder="000000" value={code}
            onChange={event => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}/>
          {error && <div className="fp-login-notice" role="alert"><ShieldCheck size={17}/><span>{error}</span></div>}
          {message && <div className="fp-login-notice" role="status"><MailCheck size={17}/><span>{message}</span></div>}
          <button className="fp-login-submit" type="submit" disabled={busy || code.length !== 6}>
            {busy ? "Verifying code…" : "Verify and sign in"} <ArrowRight size={16}/>
          </button>
          <button className="fp-login-back" type="button" disabled={busy} onClick={() => void sendSignInCode({
            preventDefault: () => undefined
          } as FormEvent<HTMLFormElement>)}>Resend code</button>
          <button className="fp-login-back" type="button" disabled={busy} onClick={backToSignIn}>Use a different email</button>
        </form>}

        {step === "forgot-email" && <form onSubmit={sendPasswordResetCode}>
          <label htmlFor="fp-forgot-email">Email address</label>
          <input id="fp-forgot-email" type="email" autoComplete="email" required maxLength={254}
            placeholder="you@example.com" value={email} onChange={event => setEmail(event.target.value)}/>
          {error && <div className="fp-login-notice" role="alert"><ShieldCheck size={17}/><span>{error}</span></div>}
          <button className="fp-login-submit" type="submit" disabled={busy || !authConfigured}>
            {busy ? "Sending recovery code…" : "Send recovery code"} <ArrowRight size={16}/>
          </button>
          <button className="fp-login-back" type="button" onClick={backToSignIn}>Back to sign in</button>
        </form>}

        {step === "forgot-code" && <form onSubmit={resetPassword}>
          <label htmlFor="fp-reset-code">Six-digit recovery code</label>
          <input id="fp-reset-code" type="text" inputMode="numeric" autoComplete="one-time-code"
            pattern="[0-9]{6}" maxLength={6} required placeholder="000000" value={code}
            onChange={event => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}/>
          <label htmlFor="fp-new-password">New password</label>
          <input id="fp-new-password" type="password" autoComplete="new-password" minLength={8}
            maxLength={128} required placeholder="At least 8 characters" value={newPassword}
            onChange={event => setNewPassword(event.target.value)}/>
          <label htmlFor="fp-confirm-password">Confirm new password</label>
          <input id="fp-confirm-password" type="password" autoComplete="new-password" minLength={8}
            maxLength={128} required placeholder="Enter the new password again" value={confirmPassword}
            onChange={event => setConfirmPassword(event.target.value)}/>
          {error && <div className="fp-login-notice" role="alert"><ShieldCheck size={17}/><span>{error}</span></div>}
          <button className="fp-login-submit" type="submit" disabled={busy || code.length !== 6 || newPassword.length < 8 || newPassword !== confirmPassword}>
            {busy ? "Resetting password…" : "Verify code and reset password"} <ArrowRight size={16}/>
          </button>
          <button className="fp-login-back" type="button" disabled={busy} onClick={backToSignIn}>Back to sign in</button>
        </form>}

        {step === "sign-in-email" && <>
          <p className="fp-login-help"><button type="button" className="fp-login-text-button" onClick={startForgotPassword}>Forgot password?</button></p>
          <p className="fp-login-help">New to FlowPay? <a href="/signup">Create an account</a></p>
        </>}
        {(step === "sign-in-code" || step === "forgot-email" || step === "forgot-code") &&
          <p className="fp-login-help">Need an account? <a href="/signup">Create an account</a></p>}

        <div className="fp-login-notice" role="note">
          <KeyRound size={17}/><span>The email verification code is six digits and is different from your transaction PIN. Fingerprint/passkey sign-in is not enabled by the current authentication provider yet.</span>
        </div>
      </div>
    </section>
    <footer className="fp-login-footer">© {new Date().getFullYear()} FlowPay <span>Secure account access</span></footer>
  </main>;
}
