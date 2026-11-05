import { useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, LockKeyhole, ShieldCheck, UserRound, MailCheck } from "lucide-react";
import { authClient, authConfigured } from "./auth-client";

type Step = "signup" | "verify";

export default function SignupPage() {
  const [step, setStep] = useState<Step>("signup");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    setError("");
    if (!authConfigured) {
      setError("Registration is not configured on this deployment yet. Please try again later.");
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
    setBusy(true);
    try {
      const result = await authClient.signUp.email({
        name: name.trim(),
        email: email.trim(),
        password
      });
      if (result.error) {
        setError(result.error.message || "Registration failed. Please check your details and try again.");
        return;
      }
      if (result.data?.user && result.data.user.emailVerified) {
        setMessage("Your email is verified. Sign in to finish onboarding. Your unique FlowPay transfer number will be assigned automatically and shown under View Account Number.");
        setPassword("");
        setConfirmPassword("");
        return;
      }
      setStep("verify");
      setMessage("A verification code has been requested for your email. Check your inbox and spam folder.");
      setPassword("");
      setConfirmPassword("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to register. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    setError("");
    if (!/^\d{4,10}$/.test(code.trim())) {
      setError("Enter the numeric verification code from your email.");
      return;
    }
    setBusy(true);
    try {
      const result = await authClient.emailOtp.verifyEmail({
        email: email.trim(),
        otp: code.trim()
      });
      if (result.error) {
        setError(result.error.message || "That verification code could not be confirmed.");
        return;
      }
      setCode("");
      setMessage("Email verified successfully. Please sign in to continue. Your FlowPay transfer number will be assigned during your first authenticated session.");
      window.location.assign("/login");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to verify this email. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function resendCode() {
    setMessage("");
    setError("");
    if (!email.trim()) {
      setError("Enter your email address first.");
      return;
    }
    setBusy(true);
    try {
      const result = await authClient.sendVerificationEmail({
        email: email.trim(),
        callbackURL: window.location.origin + "/login"
      });
      if (result.error) {
        setError(result.error.message || "Unable to send a new verification code.");
        return;
      }
      setMessage("A new verification code has been requested. Check your inbox and spam folder.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to resend the verification code.");
    } finally {
      setBusy(false);
    }
  }

  return <main className="fp-login-page">
    <a className="fp-login-back" href="/"><ArrowLeft size={16}/> Back to FlowPay</a>
    <section className="fp-login-shell">
      <div className="fp-login-aside">
        <a className="fp-public-brand" href="/"><span className="fp-public-logo">F</span>Flow<span>Pay</span></a>
        <div><span>GET STARTED</span><h1>A clearer way<br/><em>to move forward.</em></h1><p>Create your secure sign-in credentials to begin FlowPay onboarding. Your FlowPay transfer number is automatically assigned after email verification and your first sign-in.</p></div>
        <div className="fp-login-assurance"><ShieldCheck size={18}/> Your credentials are handled by the configured authentication service.</div>
      </div>
      <div className="fp-login-form-wrap">
        <div className="fp-login-icon">{step === "verify" ? <MailCheck size={23}/> : <UserRound size={23}/>}</div>
        <span className="fp-login-eyebrow">FLOWPAY ACCOUNT</span>
        <h2>{step === "verify" ? "Verify your email" : "Create account"}</h2>
        <p className="fp-login-subtitle">{step === "verify" ? <>Enter the numeric code sent to <strong>{email}</strong>.</> : "Enter your details to create your sign-in credentials."}</p>
        <div className="fp-login-notice" role="note"><ShieldCheck size={17}/><span><strong>Cardholder and bank account setup</strong><br/>Use your full legal name for your FlowPay profile. After you verify your email and sign in for the first time, FlowPay automatically assigns your unique random 10-digit FlowPay transfer number. This number receives transfers from other FlowPay customers; it is not a bank NUBAN. A dedicated bank account and card are separate provider services and appear only after the provider confirms issuance and eligibility.</span></div>
        {step === "signup" ? <form onSubmit={submit}>
          <label htmlFor="fp-signup-name">Full name</label>
          <input id="fp-signup-name" autoComplete="name" required minLength={2} maxLength={100} placeholder="Your full name" value={name} onChange={e=>setName(e.target.value)}/>
          <label htmlFor="fp-signup-email">Email address</label>
          <input id="fp-signup-email" type="email" autoComplete="email" required maxLength={254} placeholder="you@example.com" value={email} onChange={e=>setEmail(e.target.value)}/>
          <label htmlFor="fp-signup-password">Password</label>
          <div className="fp-password-field"><input id="fp-signup-password" type="password" autoComplete="new-password" required minLength={8} maxLength={128} placeholder="At least 8 characters" value={password} onChange={e=>setPassword(e.target.value)}/><LockKeyhole size={17}/></div>
          <label htmlFor="fp-signup-confirm">Confirm password</label>
          <input id="fp-signup-confirm" type="password" autoComplete="new-password" required minLength={8} maxLength={128} placeholder="Enter password again" value={confirmPassword} onChange={e=>setConfirmPassword(e.target.value)}/>
          {error && <div className="fp-login-notice" role="alert">{error}</div>}
          {message && <div className="fp-login-notice" role="status"><ShieldCheck size={17}/><span>{message}</span></div>}
          {!authConfigured && <div className="fp-login-notice" role="status">Authentication is not configured on this deployment. No credentials will be sent.</div>}
          <button className="fp-login-submit" type="submit" disabled={busy || !authConfigured}>{busy ? "Creating account…" : "Create account"} <ArrowRight size={16}/></button>
        </form> : <form onSubmit={verify}>
          <label htmlFor="fp-verification-code">Email verification code</label>
          <input id="fp-verification-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{4,10}" maxLength={10} required placeholder="Enter verification code" value={code} onChange={e=>setCode(e.target.value.replace(/[^0-9]/g, ""))}/>
          {error && <div className="fp-login-notice" role="alert">{error}</div>}
          {message && <div className="fp-login-notice" role="status"><ShieldCheck size={17}/><span>{message}</span></div>}
          <button className="fp-login-submit" type="submit" disabled={busy || !authConfigured}>{busy ? "Verifying…" : "Verify email"} <ArrowRight size={16}/></button>
          <button className="fp-login-submit" type="button" disabled={busy || !authConfigured} onClick={resendCode}>Resend verification code</button>
          <button className="fp-login-back" type="button" onClick={()=>{setStep("signup");setError("");setMessage("");}}>Use a different email</button>
        </form>}
        {step === "signup" && <p className="fp-login-help">Already registered? <a href="/login">Sign in</a></p>}
        {step === "verify" && <p className="fp-login-help">Already verified? <a href="/login">Sign in</a></p>}
      </div>
    </section>
    <footer className="fp-login-footer">© {new Date().getFullYear()} FlowPay <span>Secure account registration</span></footer>
  </main>;
}
