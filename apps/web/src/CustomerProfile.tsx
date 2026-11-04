import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Camera, FileText, ImagePlus, ShieldCheck, Trash2, UserRound, X } from "lucide-react";
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

export default function CustomerProfile({go,user,onPhotoChange}:{go:(path:string)=>void;user:{name?:string|null;email?:string|null;image?:string|null};onPhotoChange:(photo:string|null)=>void}) {
  const authSession=authClient.useSession();
  const [profile,setProfile]=useState<Profile>({fullName:user.name ?? "",email:user.email ?? "",phoneNumber:"",residentialAddress:"",photoUrl:null,updatedAt:null});
  const [loading,setLoading]=useState(true);
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [photoDataUrl,setPhotoDataUrl]=useState<string|null>(null);
  const [photoChanged,setPhotoChanged]=useState(false);
  const [photoBusy,setPhotoBusy]=useState(false);
  const [cameraOpen,setCameraOpen]=useState(false);
  const [cameraStream,setCameraStream]=useState<MediaStream|null>(null);
  const uploadInput=useRef<HTMLInputElement>(null);
  const cameraInput=useRef<HTMLInputElement>(null);
  const cameraVideo=useRef<HTMLVideoElement>(null);

  async function request(method:"GET"|"PATCH",body?:object) {
    if(authSession.isPending) throw new Error("Your sign-in session is still loading. Please wait a moment and try again.");
    // Neon Auth injects the signed JWT into the React session after sign-in.
    // Reuse the active session instead of invoking a second token-fetch request.
    const token=authSession.data?.session?.token;
    if(typeof token!=="string"||token.split(".").length!==3) {
      throw new Error("Your secure session token is unavailable or expired. Please sign out and sign in again.");
    }
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

  useEffect(()=>{
    if(cameraVideo.current&&cameraStream){
      cameraVideo.current.srcObject=cameraStream;
      void cameraVideo.current.play().catch(()=>setError("Camera preview could not start. Check browser camera permissions."));
    }
  },[cameraStream,cameraOpen]);

  useEffect(()=>()=>{cameraStream?.getTracks().forEach(track=>track.stop());},[cameraStream]);

  function closeCamera(){
    cameraStream?.getTracks().forEach(track=>track.stop());
    setCameraStream(null);
    setCameraOpen(false);
  }

  async function startCamera(){
    setError("");setNotice("");
    if(!navigator.mediaDevices?.getUserMedia){
      setNotice("Direct camera access is unavailable in this browser. Choose Camera from the photo picker instead.");
      cameraInput.current?.click();
      return;
    }
    try{
      const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"user"}},audio:false});
      setCameraStream(stream);
      setCameraOpen(true);
    }catch(reason){
      const name=reason instanceof DOMException?reason.name:"";
      if(name==="NotAllowedError"||name==="PermissionDeniedError"){
        setError("Camera permission was denied. Allow camera access in your browser or device settings, then try again.");
      }else if(name==="NotFoundError"||name==="DevicesNotFoundError"){
        setError("No camera was found on this device. You can upload an existing photo instead.");
      }else{
        setError("Unable to open the camera. Check that your camera is connected and not being used by another app.");
      }
      cameraInput.current?.click();
    }
  }

  function captureCameraPhoto(){
    const video=cameraVideo.current;
    if(!video||!video.videoWidth||!video.videoHeight){setError("Camera is not ready yet. Please wait for the preview.");return;}
    const canvas=document.createElement("canvas");
    canvas.width=video.videoWidth;canvas.height=video.videoHeight;
    const context=canvas.getContext("2d");
    if(!context){setError("Unable to capture the camera image. Please try again.");return;}
    context.drawImage(video,0,0,canvas.width,canvas.height);
    const dataUrl=canvas.toDataURL("image/jpeg",0.9);
    const size=Math.ceil((dataUrl.length-dataUrl.indexOf(",")-1)*3/4);
    if(size>MAX_PHOTO_BYTES){setError("The captured photo is larger than 3 MB. Move closer or use a lower-resolution camera setting.");return;}
    setPhotoDataUrl(dataUrl);setPhotoChanged(true);setNotice("Photo captured. Tap Save profile to store it securely.");setError("");
    closeCamera();
  }

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
      setProfile(value);setPhotoDataUrl(value.photoUrl);setPhotoChanged(false);onPhotoChange(value.photoUrl);
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
      <div className="fp-profile-card-top"><span className="fp-profile-card-brand"><span>F</span> flowpay</span></div>
      <div className="fp-profile-card-person"><div className="fp-profile-card-avatar">{visiblePhoto?<img src={visiblePhoto} alt="Customer profile" referrerPolicy="no-referrer"/>:<span>{initials}</span>}</div><div className="fp-profile-card-identity"><strong>{displayName}</strong><span>{profile.email||user.email||"Email address not provided"}</span></div></div>
      <div className="fp-profile-card-photo-actions">
        <button type="button" className="fp-outline" onClick={()=>uploadInput.current?.click()} disabled={photoBusy||saving}><ImagePlus size={15}/> Upload photo</button>
        <button type="button" className="fp-outline" onClick={startCamera} disabled={photoBusy||saving}><Camera size={15}/> Take photo</button>
        {visiblePhoto&&<button type="button" className="fp-outline" onClick={()=>{setPhotoDataUrl(null);setPhotoChanged(true);setNotice("Photo removal selected. Tap Save profile to confirm.");}} disabled={saving}><Trash2 size={15}/> Remove</button>}
      </div>
      <div className="fp-profile-card-bottom"><span>FLOWPAY ACCOUNT</span></div>
    </article>
    <input ref={uploadInput} className="fp-profile-file-input" type="file" accept="image/jpeg,image/png,image/webp" onChange={choosePhoto}/>
    <input ref={cameraInput} className="fp-profile-file-input" type="file" accept="image/jpeg,image/png,image/webp" capture="user" onChange={choosePhoto}/>
    {photoChanged&&<p className="fp-muted" role="status">Photo change not saved yet. Select Save profile to confirm.</p>}
    {loading&&<p className="fp-muted" role="status">Loading saved profile…</p>}
    {error&&<div className="fp-preview-warning" role="alert">{error}</div>}
    {notice&&<div className="fp-profile-success" role="status">{notice}</div>}
    {cameraOpen&&<div className="fp-camera-backdrop" role="presentation" onClick={closeCamera}>
      <section className="fp-camera-dialog" role="dialog" aria-modal="true" aria-labelledby="fp-camera-title" onClick={event=>event.stopPropagation()}>
        <div className="fp-camera-dialog-heading"><div><h3 id="fp-camera-title">Take profile photo</h3><p>Position your face in the frame, then capture.</p></div><button type="button" className="fp-outline" aria-label="Close camera" onClick={closeCamera}><X size={18}/></button></div>
        <video ref={cameraVideo} className="fp-camera-preview" autoPlay playsInline muted/>
        <div className="fp-camera-dialog-actions"><button type="button" className="fp-outline" onClick={closeCamera}>Cancel</button><button type="button" className="fp-primary" onClick={captureCameraPhoto}><Camera size={16}/> Capture photo</button></div>
      </section>
    </div>}
    <form className="fp-profile-edit-form" onSubmit={save}>
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
