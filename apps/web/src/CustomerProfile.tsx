import { useEffect, useState, type FormEvent } from "react";
import { FileText, ShieldCheck, UserRound } from "lucide-react";
import { authClient } from "./auth-client";

type Profile = {
  fullName: string;
  email: string;
  phoneNumber: string;
  residentialAddress: string;
  updatedAt: string | null;
};

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") || "";

export default function CustomerProfile({go,user}:{go:(path:string)=>void;user:{name?:string|null;email?:string|null;image?:string|null}}) {
  const [profile,setProfile]=useState<Profile>({fullName:user.name ?? "",email:user.email ?? "",phoneNumber:"",residentialAddress:"",updatedAt:null});
  const [loading,setLoading]=useState(true);
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");

  async function request(method:"GET"|"PATCH",body?:object) {
    const getToken=(authClient as typeof authClient & {getJWTToken?:()=>Promise<string|null>}).getJWTToken;
    const token=await getToken?.();
    if(!token) throw new Error("Your secure session token is unavailable. Please sign in again.");
    const response=await fetch(API_BASE+"/customer/profile",{method,headers:{"Authorization":"Bearer "+token,"Content-Type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});
    const data=await response.json().catch(()=>({}));
    if(!response.ok) throw new Error(data.error==="PROFILE_SERVICE_NOT_CONFIGURED"?"Profile service is not configured on the API.":data.error==="ACTIVE_CUSTOMER_ACCOUNT_REQUIRED"?"Your sign-in is not linked to an active FlowPay customer account.":data.error==="INVALID_SESSION"?"Your session expired. Please sign in again.":"Unable to load or save your profile. Please try again.");
    return data.profile as Profile;
  }

  useEffect(()=>{
    let active=true;
    request("GET").then(value=>{if(active){setProfile(value);setError("");}}).catch(reason=>{if(active)setError(reason instanceof Error?reason.message:"Unable to load profile.");}).finally(()=>{if(active)setLoading(false);});
    return ()=>{active=false;};
  },[]);

  async function save(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();setSaving(true);setError("");setNotice("");
    try { const value=await request("PATCH",{phoneNumber:profile.phoneNumber,residentialAddress:profile.residentialAddress});setProfile(value);setNotice("Your profile details have been saved securely."); }
    catch(reason){setError(reason instanceof Error?reason.message:"Unable to save profile.");}
    finally{setSaving(false);}
  }

  const displayName=profile.fullName?.trim()||user.name?.trim()||"FlowPay customer";
  const initials=displayName.split(/\s+/).filter(Boolean).slice(0,2).map(part=>part[0]?.toUpperCase()).join("")||"F";
  return <section className="fp-panel fp-detail-panel fp-profile-panel">
    <div className="fp-profile-heading"><div><span className="fp-profile-kicker">YOUR ACCOUNT</span><h2>Customer profile</h2><p className="fp-muted">Update your contact details securely.</p></div><span className="fp-profile-status"><span/> Signed in</span></div>
    <article className="fp-profile-card" aria-label="FlowPay customer profile card">
      <div className="fp-profile-card-top"><span className="fp-profile-card-brand"><span>F</span> flowpay</span><span className="fp-profile-card-label">CUSTOMER PROFILE</span></div>
      <div className="fp-profile-card-person"><div className="fp-profile-card-avatar">{user.image?<img src={user.image} alt="" referrerPolicy="no-referrer"/>:<span>{initials}</span>}</div><div className="fp-profile-card-identity"><strong>{displayName}</strong><span>{profile.email||user.email||"Email address not provided"}</span></div></div>
      <div className="fp-profile-card-bottom"><span>FLOWPAY ACCOUNT</span><b>Customer profile</b></div>
    </article>
    {loading&&<p className="fp-muted" role="status">Loading saved profile…</p>}
    {error&&<div className="fp-preview-warning" role="alert">{error}</div>}
    {notice&&<div className="fp-profile-success" role="status">{notice}</div>}
    <form className="fp-profile-edit-form" onSubmit={save}>
      <div className="fp-profile-section-title"><h3>Personal information</h3><span>Verified identity details are read-only</span></div>
      <label htmlFor="fp-profile-name">Full name</label><input id="fp-profile-name" value={displayName} readOnly/>
      <label htmlFor="fp-profile-email">Email address</label><input id="fp-profile-email" type="email" value={profile.email||user.email||""} readOnly/>
      <label htmlFor="fp-profile-phone">Phone number</label><input id="fp-profile-phone" type="tel" autoComplete="tel" maxLength={24} value={profile.phoneNumber} onChange={event=>setProfile(current=>({...current,phoneNumber:event.target.value}))} placeholder="+234 800 000 0000"/>
      <label htmlFor="fp-profile-address">Residential address</label><textarea id="fp-profile-address" rows={3} maxLength={500} autoComplete="street-address" value={profile.residentialAddress} onChange={event=>setProfile(current=>({...current,residentialAddress:event.target.value}))} placeholder="Enter your residential address"/>
      <button className="fp-primary" type="submit" disabled={saving||loading}>{saving?"Saving…":"Save profile"}</button>
    </form>
    <div className="fp-profile-section-title"><h3>Account information</h3><span>Assigned by FlowPay</span></div>
    <div className="fp-detail-list fp-profile-details"><div><span>FlowPay account number</span><b>Not yet assigned</b></div><div><span>Account tier</span><b>Not yet assigned</b></div><div><span>Account status</span><b>Signed in</b></div></div>
    <div className="fp-profile-actions"><button className="fp-outline" onClick={()=>go("/documents")}><FileText size={16}/> View verification documents</button><button className="fp-outline" onClick={()=>go("/security")}><ShieldCheck size={16}/> Security settings</button></div>
    <div className="fp-preview-warning"><UserRound size={17}/> Profile photo upload is not enabled until private object storage is configured. Your current sign-in avatar is shown when available.</div>
  </section>;
}
