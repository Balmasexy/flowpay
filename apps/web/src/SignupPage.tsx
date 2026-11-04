import { useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, LockKeyhole, ShieldCheck, UserRound } from "lucide-react";
import { authClient, authConfigured } from "./auth-client";

export default function SignupPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
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
      setMessage("Your sign-up request was accepted. Follow any email-verification instructions, then sign in. Your financial profile and account are created only after the secure customer-onboarding process is completed.");
      setPassword("");
      setConfirmPassword("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to register. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return <main className="fp-login-page">
    <a className="fp-login-back" href="/"><ArrowLeft size={16}/> Back to FlowPay</a>
    <section className="fp-login-shell">
      <div className="fp-login-aside">
        <a className="fp-public-brand" href="/"><span className="fp-public-logo">F</span>Flow<span>Pay</span></a>
        <div><span>GET STARTED</span><h1>A clearer way<br/><em>to move forward.</em></h1><p>Create your secure sign-in credentials to begin FlowPay onboarding.</p></div>
        <div className="fp-login-assurance"><ShieldCheck size={18}/> Your credentials are handled by the configured authentication service.</div>
      </div>
      <div className="fp-login-form-wrap">
        <div className="fp-login-icon"><UserRound size={23}/></div>
        <span className="fp-login-eyebrow">FLOWPAY ACCOUNT</span>
        <h2>Create account</h2>
        <p className="fp-login-subtitle">Enter your details to create your sign-in credentials.</p>
        <form onSubmit={submit}>
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
        </form>
        <p className="fp-login-help">Already registered? <a href="/login">Sign in</a></p>
      </div>
    </section>
    <footer className="fp-login-footer">© {new Date().getFullYear()} FlowPay <span>Secure account registration</span></footer>
  </main>;
}
