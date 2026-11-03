import { useState } from "react";
import { ArrowLeft, ArrowRight, Eye, EyeOff, LockKeyhole, ShieldCheck } from "lucide-react";

export default function LoginPage() {
  const [email,setEmail] = useState("");
  const [password,setPassword] = useState("");
  const [show,setShow] = useState(false);
  return <main className="fp-login-page">
    <a className="fp-login-back" href="/"><ArrowLeft size={16}/> Back to FlowPay</a>
    <section className="fp-login-shell">
      <div className="fp-login-aside"><a className="fp-public-brand" href="/"><span className="fp-public-logo">F</span>Flow<span>Pay</span></a><div><span>WELCOME BACK</span><h1>Your financial life,<br/><em>in one place.</em></h1><p>Sign in to access your FlowPay account, services and security settings.</p></div><div className="fp-login-assurance"><ShieldCheck size={18}/> Your account access is protected.</div></div>
      <div className="fp-login-form-wrap"><div className="fp-login-icon"><LockKeyhole size={23}/></div><span className="fp-login-eyebrow">FLOWPAY ACCOUNT</span><h2>Log in</h2><p className="fp-login-subtitle">Enter your account details to continue.</p>
        <form onSubmit={e=>e.preventDefault()}>
          <label htmlFor="fp-login-email">Email address</label><input id="fp-login-email" type="email" autoComplete="username" placeholder="you@example.com" value={email} onChange={e=>setEmail(e.target.value)} />
          <label htmlFor="fp-login-password">Password</label><div className="fp-password-field"><input id="fp-login-password" type={show?"text":"password"} autoComplete="current-password" placeholder="Enter your password" value={password} onChange={e=>setPassword(e.target.value)}/><button type="button" onClick={()=>setShow(!show)} aria-label={show?"Hide password":"Show password"}>{show?<EyeOff size={17}/>:<Eye size={17}/>}</button></div>
          <div className="fp-login-notice"><ShieldCheck size={17}/><span>Secure sign-in is being connected to FlowPay authentication. Login is not active yet; no credentials will be submitted or stored.</span></div>
          <button className="fp-login-submit" type="button" disabled>Sign in <ArrowRight size={16}/></button>
        </form>
        <p className="fp-login-help">Need help accessing your account? <a href="mailto:support@flowpay.ng">Contact support</a></p>
      </div>
    </section>
    <footer className="fp-login-footer">© {new Date().getFullYear()} FlowPay <span>Secure account access</span></footer>
  </main>;
}