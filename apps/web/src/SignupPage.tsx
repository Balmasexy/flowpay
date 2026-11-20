import { useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, LockKeyhole, ShieldCheck, UserRound, MailCheck, Smartphone } from "lucide-react";
import {
  authClient, authConfigured, getApiJwt, normalizeFlowPayPhone,
  sendSignupEmailCode, verifySignupEmailCode, sendSignupPhoneCode, verifySignupPhoneCode
} from "./auth-client";

type Step = "signup" | "verify-email" | "verify-phone";

function apiAddress() {
  return String(import.meta.env.VITE_API_BASE_URL || "").replace(/\\/+$/, "");
}

function responseError(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const item = body as Record<string, unknown>;
    if (typeof item.message === "string" && item.message.trim()) return item.message;
    if (typeof item.error === "string" && item.error.trim()) return item.error;
  }
  return fallback;
}

export default function SignupPage() {
  const [step, setStep] = useState<Step>("signup");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phoneInput, setPhoneInput] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [phoneCode, setPhoneCode] = useState("");
  const [phoneVerified, setPhoneVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function requestPhoneCode(value: string) {
    const sent = await sendSignupPhoneCode(value);
    if (sent.error) {
      setMessage("Your email is verified. Phone verification is the next registration step.");
      setError(sent.error.message || "Neon Auth could not send your phone verification code.");
      return false;
    }
    setStep("verify-phone");
    setMessage("Neon Auth sent a phone verification code. Enter it to finish registration.");
    setError("");
    return true;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    setError("");
    if (!authConfigured) {
      setError("Registration is not configured on this deployment yet. Please try again later.");
      return;
    }
    const normalizedPhone = normalizeFlowPayPhone(phoneInput);
    if (!normalizedPhone) {
      setError("Enter a valid Nigerian mobile number, such as 08012345678.");
      return;
    }
    if (password.length < 8) {
      setError("Use a password with at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("The passwords do not match.");
      return;
    }
    setPhoneNumber(normalizedPhone);
    setBusy(true);
    try {
      const result = await authClient.signUp.email({
        name: name.trim(),
        email: email.trim().toLowerCase(),
        password
      });
      if (result.error) {
        setError(result.error.message || "Registration failed. Please check your details and try again.");
        return;
      }
      setPassword("");
      setConfirmPassword("");
      if (result.data?.user && result.data.user.emailVerified) {
        setStep("verify-phone");
        setMessage("Your email is already verified. Neon phone verification is the final registration step.");
        await requestPhoneCode(normalizedPhone);
        return;
      }
      setStep("verify-email");
      setMessage("Neon Auth requested an email verification code. Verify your email first; the phone code follows in this same registration flow.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to register. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function verifyEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    setError("");
    if (!/^\d{4,10}$/.test(emailCode.trim())) {
      setError("Enter the numeric verification code from your email.");
      return;
    }
    if (!phoneNumber) {
      setError("Your registration phone number is missing. Return to sign-up and enter it again.");
      return;
    }
    setBusy(true);
    try {
      const result = await verifySignupEmailCode(email.trim().toLowerCase(), emailCode.trim());
      if (result.error) {
        setError(result.error.message || "That email verification code could not be confirmed.");
        return;
      }
      setEmailCode("");
      setStep("verify-phone");
      setMessage("Email verified. Requesting the phone verification code from Neon Auth…");
      await requestPhoneCode(phoneNumber);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to verify this email. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function resendEmailCode() {
    setMessage("");
    setError("");
    if (!email.trim()) {
      setError("Enter your email address first.");
      return;
    }
    setBusy(true);
    try {
      const result = await sendSignupEmailCode(email.trim().toLowerCase());
      if (result.error) {
        setError(result.error.message || "Unable to send a new email verification code.");
        return;
      }
      setMessage("A new email verification code has been requested.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to resend the email verification code.");
    } finally {
      setBusy(false);
    }
  }

  async function resendPhoneCode() {
    if (!phoneNumber || busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await requestPhoneCode(phoneNumber);
    } finally {
      setBusy(false);
    }
  }

  async function completeRegistration() {
    const apiBase = apiAddress();
    if (!apiBase) {
      setError("FlowPay API address is not configured. Your phone is verified; final onboarding cannot finish yet.");
      return;
    }
    setError("");
    setMessage("Creating your permanent FlowPay ID and linking your verified phone number…");
    try {
      const jwt = await getApiJwt();
      const bootstrap = await fetch(apiBase + "/customer/bootstrap", {
        method: "POST",
        credentials: "omit",
        headers: { Authorization: "Bearer " + jwt }
      });
      const bootstrapBody: unknown = await bootstrap.json().catch(() => null);
      if (!bootstrap.ok) {
        throw new Error(responseError(bootstrapBody, "FlowPay customer onboarding could not be completed."));
      }
      const accountNumber = bootstrapBody && typeof bootstrapBody === "object" &&
        typeof (bootstrapBody as Record<string, unknown>).flowpayAccountNumber === "string"
        ? String((bootstrapBody as Record<string, unknown>).flowpayAccountNumber) : "";
      if (!/^[1-9]\d{9}$/.test(accountNumber)) {
        throw new Error("FlowPay did not return a valid permanent 10-digit customer ID.");
      }
      if (!bootstrapBody || typeof bootstrapBody !== "object" ||
          (bootstrapBody as Record<string, unknown>).phoneAliasVerified !== true) {
        throw new Error("FlowPay did not confirm the Neon-verified phone alias during onboarding.");
      }
      setPhoneVerified(true);
      setMessage("Registration complete. Your permanent FlowPay ID has been assigned and your verified phone number is linked.");
      window.location.assign("/dashboard");
    } catch (caught) {
      setPhoneVerified(true);
      setError(caught instanceof Error ? caught.message : "Phone verified, but final FlowPay onboarding failed. Retry below.");
    }
  }

  async function finishRegistration() {
    if (busy) return;
    setBusy(true);
    try {
      await completeRegistration();
    } finally {
      setBusy(false);
    }
  }

  async function verifyPhone(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    setError("");
    if (!/^\d{6}$/.test(phoneCode.trim())) {
      setError("Enter the 6-digit phone verification code sent by Neon Auth.");
      return;
    }
    if (!phoneNumber) {
      setError("Your registration phone number is missing. Return to sign-up and enter it again.");
      return;
    }
    setBusy(true);
    try {
      const result = await verifySignupPhoneCode(phoneNumber, phoneCode.trim());
      if (result.error) {
        setError(result.error.message || "Neon Auth could not verify this phone number.");
        return;
      }
      setPhoneCode("");
      setPhoneVerified(true);
      await completeRegistration();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to verify this phone number. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return <main className="fp-login-page">
    <a className="fp-login-back" href="/"><ArrowLeft size={16}/> Back to FlowPay</a>
    <section className="fp-login-shell">
      <div className="fp-login-aside">
        <a className="fp-public-brand" href="/"><span className="fp-public-logo">F</span>Flow<span>Pay</span></a>
        <div><span>GET STARTED</span><h1>A clearer way<br/><em>to move forward.</em></h1><p>Register your contact phone number once. Neon Auth verifies it, and FlowPay automatically assigns your permanent customer ID during onboarding.</p></div>
        <div className="fp-login-assurance"><ShieldCheck size={18}/> Your identity and verification are handled by Neon Auth.</div>
      </div>
      <div className="fp-login-form-wrap">
        <div className="fp-login-icon">{step === "verify-email" ? <MailCheck size={23}/> : step === "verify-phone" ? <Smartphone size={23}/> : <UserRound size={23}/>}</div>
        <span className="fp-login-eyebrow">FLOWPAY ACCOUNT</span>
        <h2>{step === "verify-email" ? "Verify your email" : step === "verify-phone" ? "Verify your phone" : "Create account"}</h2>
        <p className="fp-login-subtitle">
          {step === "verify-email"
            ? <>Enter the numeric code sent to <strong>{email}</strong>.</>
            : step === "verify-phone"
              ? <>Enter the code sent to <strong>{phoneNumber}</strong>.</>
              : "Enter your details to create your FlowPay customer account."}
        </p>
        <div className="fp-login-notice" role="note"><ShieldCheck size={17}/><span><strong>FlowPay identity and receiving details</strong><br/>Every customer receives a permanent, unique 10-digit FlowPay ID. Your verified phone number is a second way to find the same FlowPay wallet. Neither identifier is a Nigerian bank account number. External-bank phone transfers require NIBSS NPS participant approval and certification; FlowPay does not create or invent a NUBAN.</span></div>

        {step === "signup" ? <form onSubmit={submit}>
          <label htmlFor="fp-signup-name">Full legal name</label>
          <input id="fp-signup-name" autoComplete="name" required minLength={2} maxLength={100} placeholder="Your full name" value={name} onChange={e => setName(e.target.value)}/>
          <label htmlFor="fp-signup-email">Email address</label>
          <input id="fp-signup-email" type="email" autoComplete="email" required maxLength={254} placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)}/>
          <label htmlFor="fp-signup-phone">Mobile phone number</label>
          <input id="fp-signup-phone" type="tel" inputMode="tel" autoComplete="tel" required maxLength={24} placeholder="08012345678" value={phoneInput} onChange={e => setPhoneInput(e.target.value)}/>
          <small className="fp-muted">This number is verified by Neon Auth and becomes your FlowPay recipient alias.</small>
          <label htmlFor="fp-signup-password">Password</label>
          <div className="fp-password-field"><input id="fp-signup-password" type="password" autoComplete="new-password" required minLength={8} maxLength={128} placeholder="At least 8 characters" value={password} onChange={e => setPassword(e.target.value)}/><LockKeyhole size={17}/></div>
          <label htmlFor="fp-signup-confirm">Confirm password</label>
          <input id="fp-signup-confirm" type="password" autoComplete="new-password" required minLength={8} maxLength={128} placeholder="Enter password again" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)}/>
          {error && <div className="fp-login-notice" role="alert">{error}</div>}
          {message && <div className="fp-login-notice" role="status"><ShieldCheck size={17}/><span>{message}</span></div>}
          {!authConfigured && <div className="fp-login-notice" role="status">Authentication is not configured on this deployment. No credentials will be sent.</div>}
          <button className="fp-login-submit" type="submit" disabled={busy || !authConfigured}>{busy ? "Creating account…" : "Create account"} <ArrowRight size={16}/></button>
        </form> : step === "verify-email" ? <form onSubmit={verifyEmail}>
          <label htmlFor="fp-email-verification-code">Email verification code</label>
          <input id="fp-email-verification-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{4,10}" maxLength={10} required placeholder="Enter email code" value={emailCode} onChange={e => setEmailCode(e.target.value.replace(/[^0-9]/g, ""))}/>
          {error && <div className="fp-login-notice" role="alert">{error}</div>}
          {message && <div className="fp-login-notice" role="status"><ShieldCheck size={17}/><span>{message}</span></div>}
          <button className="fp-login-submit" type="submit" disabled={busy || !authConfigured}>{busy ? "Verifying…" : "Verify email and continue"} <ArrowRight size={16}/></button>
          <button className="fp-login-submit" type="button" disabled={busy || !authConfigured} onClick={resendEmailCode}>Resend email code</button>
          <button className="fp-login-back" type="button" onClick={() => {setStep("signup");setError("");setMessage("");}}>Use a different email or phone</button>
        </form> : <form onSubmit={verifyPhone}>
          <label htmlFor="fp-phone-verification-code">6-digit phone verification code</label>
          <input id="fp-phone-verification-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required placeholder="Enter phone code" value={phoneCode} onChange={e => setPhoneCode(e.target.value.replace(/[^0-9]/g, ""))}/>
          {error && <div className="fp-login-notice" role="alert">{error}</div>}
          {message && <div className="fp-login-notice" role="status"><ShieldCheck size={17}/><span>{message}</span></div>}
          {phoneVerified && <button className="fp-login-submit" type="button" disabled={busy} onClick={() => void finishRegistration()}>{busy ? "Finishing registration…" : "Finish registration"} <ArrowRight size={16}/></button>}
          {!phoneVerified && <button className="fp-login-submit" type="submit" disabled={busy || !authConfigured}>{busy ? "Verifying…" : "Verify phone and finish"} <ArrowRight size={16}/></button>}
          <button className="fp-login-submit" type="button" disabled={busy || !authConfigured || phoneVerified} onClick={resendPhoneCode}>Resend phone code</button>
          <small className="fp-muted">After verification, FlowPay assigns the permanent 10-digit ID and links this phone number to the same customer wallet.</small>
        </form>}
        {step === "signup" && <p className="fp-login-help">Already registered? <a href="/login">Sign in</a></p>}
        {step !== "signup" && <p className="fp-login-help">Already verified? <a href="/login">Sign in</a></p>}
      </div>
    </section>
    <footer className="fp-login-footer">© {new Date().getFullYear()} FlowPay <span>Secure account registration</span></footer>
  </main>;
}
