import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import {
  ArrowLeft, Fingerprint, KeyRound, LockKeyhole, LogIn, LogOut,
  RefreshCw, ShieldCheck, Smartphone, UserPlus
} from "lucide-react";
import { passkeyPrototypeApiBase, passkeyPrototypeAuthClient } from "./passkey-prototype-auth-client";

type PasskeyRecord = { id:string; name?:string|null; deviceType?:string|null; backedUp?:boolean };
type PrototypeStatus = {
  configured:boolean; passkeyCount:number; transactionPinConfigured:boolean;
  transactionVerification:string; transferSubmissionEnabled:boolean;
};
type TransferContext = {
  accountNumber:string; bankCode:string; amountMinor:string; idempotencyKey:string;
};

function messageFrom(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
function amountToMinor(value: string): string | null {
  if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(value.trim())) return null;
  const [whole, fraction=""] = value.trim().split(".");
  try { return (BigInt(whole) * 100n + BigInt((fraction+"00").slice(0,2))).toString(); }
  catch { return null; }
}
async function requestJson(path:string, body?:unknown):Promise<Record<string,unknown>> {
  const response=await fetch(passkeyPrototypeApiBase+path,{
    method:body===undefined?"GET":"POST",
    credentials:"include",
    headers:body===undefined?undefined:{"Content-Type":"application/json"},
    body:body===undefined?undefined:JSON.stringify(body),
    cache:"no-store"
  });
  const payload=await response.json().catch(()=>({}));
  if(!response.ok) {
    const code=payload && typeof payload==="object" && "error" in payload ? String(payload.error) : "REQUEST_FAILED";
    throw new Error(code);
  }
  return payload as Record<string,unknown>;
}

export default function PasskeyPrototypePage() {
  const sessionState=passkeyPrototypeAuthClient.useSession();
  const user=sessionState.data?.user ?? null;
  const isPending=sessionState.isPending;
  const [mode,setMode]=useState<"signup"|"signin">("signup");
  const [name,setName]=useState("");
  const [email,setEmail]=useState("");
  const [password,setPassword]=useState("");
  const [passkeyName,setPasskeyName]=useState("FlowPay Android device");
  const [passkeys,setPasskeys]=useState<PasskeyRecord[]>([]);
  const [status,setStatus]=useState<PrototypeStatus|null>(null);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [pin,setPin]=useState("");
  const [accountNumber,setAccountNumber]=useState("");
  const [bankCode,setBankCode]=useState("");
  const [amount,setAmount]=useState("");
  const [transferPin,setTransferPin]=useState("");
  const [approval,setApproval]=useState<Record<string,unknown>|null>(null);

  const amountMinor=useMemo(()=>amountToMinor(amount),[amount]);
  const canUseWebAuthn=typeof window!=="undefined" && "PublicKeyCredential" in window &&
    Boolean(navigator.credentials && navigator.credentials.create && navigator.credentials.get);

  const loadSecurity=useCallback(async()=>{
    if(!user) { setPasskeys([]); setStatus(null); return; }
    setLoading(true);
    try{
      const [listed,summary]=await Promise.all([
        passkeyPrototypeAuthClient.passkey.listUserPasskeys(),
        requestJson("/prototype-security/status")
      ]);
      if(listed.error) throw new Error(listed.error.message || "PASSKEY_LIST_UNAVAILABLE");
      setPasskeys((listed.data ?? []) as PasskeyRecord[]);
      setStatus(summary as unknown as PrototypeStatus);
    }catch(cause){
      setError(messageFrom(cause,"Unable to load passkey settings."));
    }finally{setLoading(false);}
  },[user?.id]);

  useEffect(()=>{ void loadSecurity(); },[loadSecurity]);

  async function accountSubmit(event:FormEvent<HTMLFormElement>){
    event.preventDefault(); setError(""); setNotice(""); setLoading(true);
    try{
      const result=mode==="signup"
        ? await passkeyPrototypeAuthClient.signUp.email({name:name.trim(),email:email.trim().toLowerCase(),password})
        : await passkeyPrototypeAuthClient.signIn.email({email:email.trim().toLowerCase(),password});
      if(result.error) throw new Error(result.error.message || "AUTHENTICATION_FAILED");
      setPassword("");
      setNotice(mode==="signup"?"Test account created. Add a device passkey to continue.":"Signed in to the isolated passkey environment.");
      await sessionState.refetch();
    }catch(cause){
      setError(messageFrom(cause,"Authentication failed."));
    }finally{setLoading(false);}
  }

  async function signInWithPasskey(){
    setError("");setNotice("");setLoading(true);
    try{
      if(!canUseWebAuthn) throw new Error("DEVICE_PASSKEY_NOT_AVAILABLE_IN_THIS_BROWSER");
      const result=await passkeyPrototypeAuthClient.signIn.passkey({
        fetchOptions:{credentials:"include"}
      });
      if(result.error) throw new Error(result.error.message || "PASSKEY_SIGN_IN_FAILED");
      setNotice("Your device passkey verified your sign-in.");
      await sessionState.refetch();
    }catch(cause){
      setError(messageFrom(cause,"Passkey sign-in failed."));
    }finally{setLoading(false);}
  }

  async function registerPasskey(){
    setError("");setNotice("");setLoading(true);
    try{
      if(!canUseWebAuthn) throw new Error("DEVICE_PASSKEY_NOT_AVAILABLE_IN_THIS_BROWSER");
      const result=await passkeyPrototypeAuthClient.passkey.addPasskey({
        name:passkeyName.trim() || "FlowPay device passkey",
        authenticatorAttachment:"platform"
      });
      if(result.error) throw new Error(result.error.message || "PASSKEY_REGISTRATION_FAILED");
      setNotice("Device passkey registered. Your phone's supported biometric or screen-lock prompt will be used for verification.");
      await loadSecurity();
    }catch(cause){
      setError(messageFrom(cause,"Could not register this device passkey."));
    }finally{setLoading(false);}
  }

  async function removePasskey(id:string){
    setError("");setNotice("");setLoading(true);
    try{
      const result=await passkeyPrototypeAuthClient.passkey.deletePasskey({id});
      if(result.error) throw new Error(result.error.message || "PASSKEY_REMOVAL_FAILED");
      setNotice("Passkey removed from this test account.");
      await loadSecurity();
    }catch(cause){
      setError(messageFrom(cause,"Could not remove this passkey."));
    }finally{setLoading(false);}
  }

  async function setupPin(event:FormEvent<HTMLFormElement>){
    event.preventDefault();setError("");setNotice("");setLoading(true);
    try{
      await requestJson("/prototype-security/transaction-pin/setup",{transactionPin:pin});
      setPin("");
      setNotice("Your six-digit transaction PIN is configured separately from your passkey.");
      await loadSecurity();
    }catch(cause){
      setError(messageFrom(cause,"Could not configure the transaction PIN."));
    }finally{setLoading(false);}
  }

  async function verifyTransfer(event:FormEvent<HTMLFormElement>){
    event.preventDefault();setError("");setNotice("");setApproval(null);setLoading(true);
    try{
      if(!canUseWebAuthn) throw new Error("DEVICE_PASSKEY_NOT_AVAILABLE_IN_THIS_BROWSER");
      if(!/^\d{10}$/.test(accountNumber.trim())) throw new Error("ENTER_A_10_DIGIT_TEST_ACCOUNT_NUMBER");
      if(!/^[A-Za-z0-9_-]{2,12}$/.test(bankCode.trim())) throw new Error("ENTER_A_TEST_BANK_CODE");
      if(!amountMinor || BigInt(amountMinor)<=0n) throw new Error("ENTER_A_VALID_NAIRA_AMOUNT");
      if(!/^\d{6}$/.test(transferPin)) throw new Error("ENTER_YOUR_SIX_DIGIT_TRANSACTION_PIN");
      const context:TransferContext={
        accountNumber:accountNumber.trim(),
        bankCode:bankCode.trim(),
        amountMinor,
        idempotencyKey:crypto.randomUUID()
      };
      const challenge=await requestJson("/prototype-security/transaction/options",context);
      if(typeof challenge.challengeId!=="string" || !challenge.options || typeof challenge.options!=="object")
        throw new Error("PASSKEY_CHALLENGE_RESPONSE_INVALID");
      setNotice("Confirm with your device now. The browser will request a biometric or screen-lock verification.");
      const response=await startAuthentication({optionsJSON:challenge.options as Parameters<typeof startAuthentication>[0]["optionsJSON"]});
      const result=await requestJson("/prototype-security/transaction/verify",{
        ...context,
        challengeId:challenge.challengeId,
        transactionPin:transferPin,
        response
      });
      setApproval(result);
      setTransferPin("");
      setNotice("Transaction PIN and device passkey both verified. No payment was sent.");
    }catch(cause){
      setError(messageFrom(cause,"Transaction authorization failed."));
    }finally{setLoading(false);}
  }

  async function signOut(){
    setLoading(true);setError("");setNotice("");
    try{
      await passkeyPrototypeAuthClient.signOut({fetchOptions:{credentials:"include"}});
      setApproval(null);setPin("");setTransferPin("");
      await sessionState.refetch();
      setNotice("Signed out of the isolated passkey prototype.");
    }catch(cause){
      setError(messageFrom(cause,"Could not sign out."));
    }finally{setLoading(false);}
  }

  return <main className="fp-login-page fp-passkey-prototype-page">
    <a className="fp-login-back" href="/login"><ArrowLeft size={16}/> Back to FlowPay login</a>
    <section className="fp-passkey-prototype-shell">
      <header className="fp-passkey-prototype-header">
        <div className="fp-login-icon"><Fingerprint size={25}/></div>
        <span className="fp-login-eyebrow">ISOLATED SECURITY TEST</span>
        <h1>FlowPay device passkey</h1>
        <p>Test Android fingerprint or the device's secure screen-lock verification without changing your live FlowPay login.</p>
        <div className="fp-passkey-warning"><ShieldCheck size={17}/><span>Separate test environment. No production account, wallet balance, transaction or payment is accessed.</span></div>
      </header>

      {error && <div className="fp-login-notice" role="alert">{error}</div>}
      {notice && <div className="fp-login-notice" role="status"><ShieldCheck size={17}/><span>{notice}</span></div>}

      {isPending ? <section className="fp-passkey-prototype-card"><p>Checking prototype session…</p></section> :
      !user ? <section className="fp-passkey-prototype-card">
        <h2>{mode==="signup"?"Create a test account":"Sign in to your test account"}</h2>
        <p className="fp-login-subtitle">Use a test email and a password to create the initial passkey identity. After registering a passkey, you can sign in with it directly.</p>
        <div className="fp-passkey-mode-switch">
          <button type="button" className={mode==="signup"?"active":""} onClick={()=>{setMode("signup");setError("");setNotice("");}}>Create test account</button>
          <button type="button" className={mode==="signin"?"active":""} onClick={()=>{setMode("signin");setError("");setNotice("");}}>Existing test account</button>
        </div>
        <form onSubmit={accountSubmit}>
          {mode==="signup" && <>
            <label htmlFor="fp-passkey-name">Name</label>
            <input id="fp-passkey-name" value={name} onChange={e=>setName(e.target.value)} required minLength={2} maxLength={100} placeholder="Test user"/>
          </>}
          <label htmlFor="fp-passkey-email">Email address</label>
          <input id="fp-passkey-email" type="email" value={email} onChange={e=>setEmail(e.target.value)} required maxLength={254} autoComplete="email" placeholder="test@example.com"/>
          <label htmlFor="fp-passkey-password">Password</label>
          <input id="fp-passkey-password" type="password" value={password} onChange={e=>setPassword(e.target.value)} required minLength={10} maxLength={128} autoComplete={mode==="signup"?"new-password":"current-password"} placeholder="At least 10 characters"/>
          <button className="fp-login-submit" type="submit" disabled={loading}>{loading?"Please wait…":mode==="signup"?"Create isolated test account":"Sign in"} <ArrowLeft size={16}/></button>
        </form>
        <div className="fp-passkey-divider"><span>OR</span></div>
        <button className="fp-passkey-action" type="button" disabled={loading||!canUseWebAuthn} onClick={()=>void signInWithPasskey()}>
          <Fingerprint size={20}/> Sign in with device passkey
        </button>
        {!canUseWebAuthn && <p className="fp-passkey-small">This browser does not expose WebAuthn credentials. Use a supported HTTPS browser on an Android or desktop device.</p>}
      </section> :
      <>
        <section className="fp-passkey-prototype-card">
          <div className="fp-passkey-user-row">
            <div><span className="fp-login-eyebrow">SIGNED IN TEST USER</span><h2>{user.name || user.email}</h2><p>{user.email}</p></div>
            <button type="button" className="fp-outline" onClick={()=>void signOut()} disabled={loading}><LogOut size={16}/> Sign out</button>
          </div>
          <div className="fp-passkey-card-head"><h3><Fingerprint size={19}/> Device passkeys</h3><button type="button" className="fp-outline" onClick={()=>void loadSecurity()} disabled={loading}><RefreshCw size={15}/> Refresh</button></div>
          <div className="fp-passkey-register-row">
            <input aria-label="Passkey name" value={passkeyName} onChange={e=>setPasskeyName(e.target.value)} maxLength={80}/>
            <button className="fp-login-submit" type="button" onClick={()=>void registerPasskey()} disabled={loading||!canUseWebAuthn}><Fingerprint size={17}/> Add device passkey</button>
          </div>
          {passkeys.length===0 ? <div className="fp-passkey-empty"><Smartphone size={22}/><b>No device passkey registered</b><span>Register a passkey to enable fingerprint or secure screen-lock verification.</span></div> :
            <div className="fp-passkey-list">{passkeys.map(item=><div className="fp-passkey-item" key={item.id}>
              <span className="fp-passkey-item-icon"><KeyRound size={18}/></span>
              <div><b>{item.name || "FlowPay passkey"}</b><small>{item.deviceType || "Device authenticator"}{item.backedUp?" · Synced backup":""}</small></div>
              <button type="button" className="fp-passkey-remove" onClick={()=>void removePasskey(item.id)} disabled={loading}>Remove</button>
            </div>)}</div>}
        </section>

        <section className="fp-passkey-prototype-card">
          <h2>Transaction PIN</h2>
          <p className="fp-login-subtitle">This six-digit PIN is separate from your email verification code and your device passkey.</p>
          {status?.transactionPinConfigured ? <div className="fp-passkey-status"><ShieldCheck size={18}/> Transaction PIN configured</div> :
            <form onSubmit={setupPin}>
              <label htmlFor="fp-passkey-pin">Create six-digit transaction PIN</label>
              <input id="fp-passkey-pin" type="password" inputMode="numeric" autoComplete="new-password" value={pin} onChange={e=>setPin(e.target.value.replace(/\D/g,"").slice(0,6))} minLength={6} maxLength={6} pattern="[0-9]{6}" required placeholder="••••••"/>
              <button className="fp-login-submit" type="submit" disabled={loading||pin.length!==6}>Set transaction PIN</button>
            </form>}
        </section>

        <section className="fp-passkey-prototype-card">
          <h2>Verify a bank-transfer review</h2>
          <p className="fp-login-subtitle">This tests the two-factor approval sequence. Bank details are not checked with a provider and no money will be moved.</p>
          <form onSubmit={verifyTransfer}>
            <label htmlFor="fp-proto-bank-code">Bank code (test input)</label>
            <input id="fp-proto-bank-code" value={bankCode} onChange={e=>setBankCode(e.target.value.trim())} maxLength={12} required placeholder="Bank code"/>
            <label htmlFor="fp-proto-account">Account number (test input)</label>
            <input id="fp-proto-account" inputMode="numeric" value={accountNumber} onChange={e=>setAccountNumber(e.target.value.replace(/\D/g,"").slice(0,10))} maxLength={10} required placeholder="10-digit account number"/>
            <label htmlFor="fp-proto-amount">Amount (NGN)</label>
            <input id="fp-proto-amount" inputMode="decimal" value={amount} onChange={e=>setAmount(e.target.value)} required placeholder="0.00"/>
            <label htmlFor="fp-proto-transfer-pin">Transaction PIN</label>
            <input id="fp-proto-transfer-pin" type="password" inputMode="numeric" autoComplete="off" value={transferPin} onChange={e=>setTransferPin(e.target.value.replace(/\D/g,"").slice(0,6))} maxLength={6} required placeholder="Six-digit transaction PIN"/>
            <button className="fp-login-submit" type="submit" disabled={loading||!status?.transactionPinConfigured||passkeys.length===0||!canUseWebAuthn||transferPin.length!==6}>
              <Fingerprint size={18}/> {loading?"Verifying factors…":"Verify PIN and fingerprint"}
            </button>
          </form>
          {approval && <div className="fp-passkey-approval-result">
            <ShieldCheck size={22}/>
            <div><b>Both security factors verified</b><span>Transaction PIN: verified</span><span>Device passkey: verified</span><strong>Payment not submitted</strong></div>
          </div>}
        </section>
      </>}

      <footer className="fp-passkey-prototype-footer">
        <span>FlowPay · Isolated passkey prototype</span>
        <span>WebAuthn user verification required</span>
      </footer>
    </section>
  </main>;
}
