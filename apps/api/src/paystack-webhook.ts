import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool, PoolClient } from "pg";

type Options = { pool: Pool | null };
type Deposit = { transaction_id:string; reference:string; provider_transaction_id:string|null; amount_minor:string; currency:string; status:string };
function send(res:ServerResponse,status:number,body:unknown){res.writeHead(status);res.end(JSON.stringify(body));}
async function readRaw(req:IncomingMessage):Promise<Buffer>{
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of req){const b=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=b.length;if(size>65536)throw new Error("PAYLOAD_TOO_LARGE");chunks.push(b);}
  return Buffer.concat(chunks);
}
function minor(value:unknown):string|null{
  if(typeof value!=="number"&&typeof value!=="string")return null;
  const s=String(value);return /^\d{1,15}$/.test(s)&&Number.isSafeInteger(Number(s))&&Number(s)>0?s:null;
}
export function createPaystackWebhookHandler({pool}:Options){
 return async function handlePaystackWebhook(req:IncomingMessage,res:ServerResponse):Promise<boolean>{
  const path=new URL(req.url??"/","http://localhost").pathname.replace(/\/+$/,"")||"/";
  if(req.method!=="POST"||path!=="/webhooks/paystack")return false;
  const secret=process.env.PAYSTACK_SECRET_KEY?.trim()??"";
  if(process.env.PAYSTACK_ENVIRONMENT!=="test"||!secret.startsWith("sk_test_")){send(res,503,{error:"PAYSTACK_SANDBOX_CONFIGURATION_REQUIRED"});return true;}
  if(!pool){send(res,503,{error:"WEBHOOK_DATABASE_UNAVAILABLE"});return true;}
  let raw:Buffer;
  try{raw=await readRaw(req);}catch(error){send(res,413,{error:error instanceof Error?error.message:"PAYLOAD_TOO_LARGE"});return true;}
  const signature=req.headers["x-paystack-signature"];
  const supplied=typeof signature==="string"?signature:"";
  const expected=createHmac("sha512",secret).update(raw).digest("hex");
  const a=Buffer.from(supplied,"utf8");const b=Buffer.from(expected,"utf8");
  if(a.length!==b.length||!timingSafeEqual(a,b)){send(res,401,{error:"INVALID_WEBHOOK_SIGNATURE"});return true;}
  let payload:unknown;
  try{payload=JSON.parse(raw.toString("utf8"));}catch{send(res,400,{error:"INVALID_JSON"});return true;}
  const event=payload&&typeof payload==="object"&&!Array.isArray(payload)?payload as Record<string,unknown>:{};
  if(event.event!=="charge.success"){send(res,200,{received:true,ignored:true});return true;}
  const data=event.data&&typeof event.data==="object"&&!Array.isArray(event.data)?event.data as Record<string,unknown>:{};
  const reference=typeof data.reference==="string"?data.reference:"";
  const amount=minor(data.amount);
  if(!reference||!amount){send(res,202,{received:true,processed:false,reason:"INVALID_PROVIDER_EVENT"});return true;}

  let verifiedResponse:Response;let verifiedPayload:unknown;
  try{
    verifiedResponse=await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,{
      headers:{Authorization:`Bearer ${secret}`,Accept:"application/json"},signal:AbortSignal.timeout(12000)});
    verifiedPayload=await verifiedResponse.json().catch(()=>null);
  }catch(error){console.error("Paystack verification request failed:",error instanceof Error?error.message:"network error");send(res,503,{error:"PROVIDER_VERIFICATION_UNAVAILABLE"});return true;}
  const body=verifiedPayload&&typeof verifiedPayload==="object"&&!Array.isArray(verifiedPayload)?verifiedPayload as Record<string,unknown>:{};
  const verified=body.data&&typeof body.data==="object"&&!Array.isArray(body.data)?body.data as Record<string,unknown>:{};
  if(!verifiedResponse.ok||body.status!==true||verified.status!=="success"||verified.domain!=="test"){
    send(res,202,{received:true,processed:false,reason:"PROVIDER_TRANSACTION_NOT_VERIFIED"});return true;
  }
  const verifiedReference=typeof verified.reference==="string"?verified.reference:"";
  const verifiedAmount=minor(verified.amount);
  const currency=typeof verified.currency==="string"?verified.currency:"";
  const providerId=typeof verified.id==="number"&&Number.isSafeInteger(verified.id)?String(verified.id):null;
  if(!providerId||verifiedReference!==reference||verifiedAmount!==amount||currency!=="NGN"||
     data.currency!=="NGN"||String(data.status??"").toLowerCase()!=="success"){
    send(res,202,{received:true,processed:false,reason:"PROVIDER_EVENT_MISMATCH"});return true;
  }

  let client:PoolClient;
  try{client=await pool.connect();}catch{send(res,503,{error:"WEBHOOK_DATABASE_UNAVAILABLE"});return true;}
  try{
    await client.query("BEGIN");
    const result=await client.query<Deposit>(
      `SELECT transaction_id,reference,provider_transaction_id,amount_minor::text,currency,status
         FROM public.fp_paystack_deposits WHERE reference=$1 FOR UPDATE`,[reference]);
    if(result.rowCount!==1||!result.rows[0]){await client.query("ROLLBACK");send(res,202,{received:true,processed:false,reason:"FLOWPAY_DEPOSIT_REFERENCE_NOT_FOUND"});return true;}
    const deposit=result.rows[0];
    if(deposit.currency.trim()!=="NGN"||deposit.amount_minor!==verifiedAmount||
       (deposit.provider_transaction_id&&deposit.provider_transaction_id!==providerId)||deposit.status==="failed"){
      await client.query("ROLLBACK");send(res,202,{received:true,processed:false,reason:"FLOWPAY_DEPOSIT_MISMATCH"});return true;
    }
    const digest=createHash("sha256").update(raw).digest("hex");
    const inserted=await client.query(
      `INSERT INTO public.fp_payment_events(provider,provider_event_id,event_type,transaction_id,payload_sha256,processing_status)
       VALUES('paystack',$1,'charge.success',$2,$3,'pending')
       ON CONFLICT(provider,provider_event_id) DO NOTHING RETURNING provider_event_id`,
      [reference,deposit.transaction_id,digest]);
    if(inserted.rowCount===0){await client.query("COMMIT");send(res,200,{received:true,processed:true,duplicate:true,walletCredited:false});return true;}
    await client.query(
      `UPDATE public.fp_paystack_deposits SET provider_transaction_id=$2,verified_at=COALESCE(verified_at,NOW())
        WHERE transaction_id=$1 AND status='pending'`,[deposit.transaction_id,providerId]);
    await client.query(
      "UPDATE public.fp_payment_events SET processing_status='processed' WHERE provider='paystack' AND provider_event_id=$1",[reference]);
    await client.query("COMMIT");
    send(res,200,{received:true,processed:true,providerVerified:true,transactionId:deposit.transaction_id,status:"pending",walletCredited:false});
    return true;
  }catch(error){
    await client.query("ROLLBACK").catch(()=>undefined);
    console.error("Paystack webhook processing failed:",error instanceof Error?error.message:"database error");
    send(res,503,{error:"WEBHOOK_PROCESSING_UNAVAILABLE"});return true;
  }finally{client.release();}
 };
}
