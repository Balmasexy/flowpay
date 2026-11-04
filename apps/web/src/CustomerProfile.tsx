import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Camera, FileText, ImagePlus, ShieldCheck, Trash2, UserRound } from "lucide-react";
import { authClient } from "./auth-client";

type Profile = {
  fullName: string;
  email: string;
  phoneNumber: string;
  residentialAddress: string;
  photoUrl: string | null;
  updatedAt: string | null;
};

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") || "";
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;

export default function CustomerProfile({go,user}:{go:(path:string)=>void;user:{name?:string|null;email?:string|null;image?:string|null}}) {
  const [profile,setProfile]=useState<Profile>({fullName:user.name ?? "",email:user.email ?? "",phoneNumber:"",residentialAddress:"",photoUrl:null,updatedAt:null});
  const [loading,setLoading]=useState(true);
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [photoDataUrl,setPhotoDataUrl]=useState<string|null>(null);
  const [photoChanged,setPhotoChanged]=useState(false);
  const [photoBusy,setPhotoBusy]=useState(false);
  const uploadInput=useRef<HTMLInputElement>(null);
  const cameraInput=useRef<HTMLInputElement>(null);

  async function request(method:"GET"|"PATCH",body?:object) {
    const tokenClient=authClient as typeof authClient & {getJWTToken?:()=>Promise<string|null>};
    // Call through the client object: the SDK method relies on its own client context.
    const token=await tokenClient.getJWTToken?.();
    if(!token) throw new Error("The Neon Auth JWT helper is unavailable. Please sign out and sign in again.");
    if(!API_BASE) throw new Error("FlowPay API address is missing from the web app configuration.");
    const response=await fetch(API_BASE+"/customer/profile",{method,credentials:"omit",headers:{"Authorization":"Bearer "+token,"Content-Type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});
    const data=await response.json().catch(()=>({}));
    if(!response.ok) {
      const messages:Record<string,string>={
        PROFILE_SERVICE_NOT_CONFIGURED:"The profile API is missing its database or Neon Auth configuration.",
        PROFILE_SERVICE_UNAVAILABLE:"The profile API could not save to the database. Please retry shortly.",
        ACTIVE_CUSTOMER_ACCOUNT_REQUIRED:"Your sign-in is not linked to an active FlowPay customer account.",
        INVALID_SESSION:"Your session expired. Please sign in again.",
        AUTHENTICATION_REQUIRED:"Please sign in again to update your profile.",
        INVALID_PHONE_NUMBER:"Enter a valid phone number, including country code if needed.",
        ADDRESS_TOO_LONG:"Residential address must be 500 characters or fewer.",
        INVALID_PROFILE_PHOTO:"Choose a JPG, PNG or WebP image up to 3 MB.",
        PROFILE_PAYLOAD_TOO_LARGE:"The profile photo is too large. Choose an image under 3 MB."
      };
      throw new Error(messages[data.error]||("Profile request failed ("+response.status+"). "+(typeof data.error==="string"?data.error:"Please try again.")));
    }
    return data.profile as Profile;
  }

  useEffect(()=>{
    let active=true;
    request("GET").then(value=>{if(active){setProfile(value);setPhotoDataUrl(value.photoUrl);setError("");}}).catch(reason=>{if(active)setError(reason instanceof Error?reason.message:"Unable to load profile.");}).finally(()=>{if(active)setLoading(false);});
    return ()=>{active=false;};
  },[]);

  async function choosePhoto(event:ChangeEvent<HTMLInputElement>) {
    const file=event.target.files?.[0];
    event.target.value="";
    if(!file)return;
    setError("");setNotice("");
    if(!["image/jpeg","image/png","image/webp"].includes(file.type)||file.size>MAX_PHOTO_BYTES) {
      setError("Choose a JPG, PNG or WebP image up to 3 MB.");return;
    }
    setPhotoBusy(true);
    try {
      const dataUrl=await new Promise<string>((resolve,reject)=>{
        const reader=new FileReader();
        reader.onerror=()=>reject(new Error("Unable to read the selected photo."));
        reader.onload=()=>typeof reader.result==="string"?resolve(reader.result):reject(new Error("Unable to read the selected photo."));
        reader.readAsDataURL(file);
      });
      setPhotoDataUrl(dataUrl);setPhotoChanged(true);setNotice("Photo selected. Tap Save profile to store it securely.");
    } catch(reason) {setError(reason instanceof Error?reason.message:"Unable to read photo.");}
    finally {setPhotoBusy(false);}
  }

  async function save(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();setSaving(true);setError("");setNotice("");
    try {
      const payload:Record<string,unknown>={phoneNumber:profile.phoneNumber,residentialAddress:profile.residentialAddress};
      if(photoChanged)payload.photoDataUrl=photoDataUrl;
      const value=await request("PATCH",payload);
      setProfile(value);setPhotoDataUrl(value.photoUrl);setPhotoChanged(false);
      setNotice("Your profile details and photo have been saved securely.");
    } catch(reason){setError(reason instanceof Error?reason.message:"Unable to save profile.");}
    finally{setSaving(false);}
  }

  const displayName=profile.fullName?.trim()||user.name?.trim()||"FlowPay customer";
  const initials=displayName.split(/\s+/).filter(Boolean).slice(0,2).map(part=>part[0]?.toUpperCase()).join("")||"F";
  const visiblePhoto=photoChanged?photoDataUrl:(profile.photoUrl??user.image??null);
  return <section className="fp-panel fp-detail-panel fp-profile-panel">
    <div className="fp-profile-heading"><div><span className="fp-profile-kicker">YOUR ACCOUNT</span><h2>Customer profile</h2><p className="fp-muted">Update your contact details and profile photo securely.</p></div><span className="fp-profile-status"><span/> Signed in</span></div>
    <article className="fp-profile-card" aria-label="FlowPay customer profile card">
      <div className="fp-profile-card-top"><span className="fp-profile-card-brand"><span>F</span> flowpay</span><span className="fp-profile-card-label">CUSTOMER PROFILE</span></div>
      <div className="fp-profile-card-person"><div className="fp-profile-card-avatar">{visiblePhoto?<img src={visiblePhoto} alt="Customer profile" referrerPolicy="no-referrer"/>:<span>{initials}</span>}</div><div className="fp-profile-card-identity"><strong>{displayName}</strong><span>{profile.email||user.email||"Email address not provided"}</span></div></div>
      <div className="fp-profile-card-bottom"><span>FLOWPAY ACCOUNT</span><b>Customer profile</b></div>
    </article>
    {loading&&<p className="fp-muted" role="status">Loading saved profile…</p>}
    {error&&<div className="fp-preview-warning" role="alert">{error}</div>}
    {notice&&<div className="fp-profile-success" role="status">{notice}</div>}
    <form className="fp-profile-edit-form" onSubmit={save}>
      <div className="fp-profile-section-title"><h3>Profile photo</h3><span>JPG, PNG or WebP · up to 3 MB</span></div>
      <div className="fp-profile-photo-editor">
        <div className="fp-profile-photo-preview">{visiblePhoto?<img src={visiblePhoto} alt="Profile photo preview"/>:<span>{initials}</span>}</div>
        <div className="fp-profile-photo-controls">
          <div className="fp-profile-photo-buttons">
            <button type="button" className="fp-outline" onClick={()=>uploadInput.current?.click()} disabled={photoBusy||saving}><ImagePlus size={16}/> Upload photo</button>
            <button type="button" className="fp-outline" onClick={()=>cameraInput.current?.click()} disabled={photoBusy||saving}><Camera size={16}/> Take photo</button>
            {visiblePhoto&&<button type="button" className="fp-outline" onClick={()=>{setPhotoDataUrl(null);setPhotoChanged(true);setNotice("Photo removal selected. Tap Save profile to confirm.");}} disabled={saving}><Trash2 size={16}/> Remove</button>}
          </div>
          <small>{photoBusy?"Reading photo…":photoChanged?"Photo change not saved yet.":"Your photo is private and visible only in your signed-in profile."}</small>
        </div>
      </div>
      <input ref={uploadInput} className="fp-profile-file-input" type="file" accept="image/jpeg,image/png,image/webp" onChange={choosePhoto}/>
      <input ref={cameraInput} className="fp-profile-file-input" type="file" accept="image/jpeg,image/png,image/webp" capture="user" onChange={choosePhoto}/>
      <div className="fp-profile-section-title"><h3>Personal information</h3><span>Verified identity details are read-only</span></div>
      <label htmlFor="fp-profile-name">Full name</label><input id="fp-profile-name" value={displayName} readOnly/>
      <label htmlFor="fp-profile-email">Email address</label><input id="fp-profile-email" type="email" value={profile.email||user.email||""} readOnly/>
      <label htmlFor="fp-profile-phone">Phone number</label><input id="fp-profile-phone" type="tel" autoComplete="tel" maxLength={24} value={profile.phoneNumber} onChange={event=>setProfile(current=>({...current,phoneNumber:event.target.value}))} placeholder="+234 800 000 0000"/>
      <label htmlFor="fp-profile-address">Residential address</label><textarea id="fp-profile-address" rows={3} maxLength={500} autoComplete="street-address" value={profile.residentialAddress} onChange={event=>setProfile(current=>({...current,residentialAddress:event.target.value}))} placeholder="Enter your residential address"/>
      <button className="fp-primary" type="submit" disabled={saving||loading||photoBusy}>{saving?"Saving…":"Save profile"}</button>
    </form>
    <div className="fp-profile-section-title"><h3>Account information</h3><span>Assigned by FlowPay</span></div>
    <div className="fp-detail-list fp-profile-details"><div><span>FlowPay account number</span><b>Not yet assigned</b></div><div><span>Account tier</span><b>Not yet assigned</b></div><div><span>Account status</span><b>Signed in</b></div></div>
    <div className="fp-profile-actions"><button className="fp-outline" onClick={()=>go("/documents")}><FileText size={16}/> View verification documents</button><button className="fp-outline" onClick={()=>go("/security")}><ShieldCheck size={16}/> Security settings</button></div>
    <div className="fp-preview-warning"><UserRound size={17}/> Only your own authenticated profile photo and contact details can be changed.</div>
  </section>;
}
