import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { settleVerifiedFlutterwaveDeposit } from "./flutterwave-settlement.js";

type Options = {
  pool: Pool | null;
  jwks: ReturnType<typeof createRemoteJWKSet> | null;
  issuer?: string;
  audience?: string;
};
type Deposit = {
  transaction_id:string;
  provider_tx_ref:string;
  provider_transaction_id:string|null;
  amount_minor:string;
  currency:string;
  status:"pending"|"posted"|"failed";
  verified_at:string|null;
};

function send(res:ServerResponse,status:number,body:unknown){
  res.writeHead(status);
  res.end(JSON.stringify(body));
}
function record(value:unknown):Record<string,unknown>{
  return value && typeof value==="object" && !Array.isArray(value) ? value as Record<string,unknown> : {};
}
function isJwtError(error:unknown){
  return error instanceof Error && [
    "JWTExpired","JWSSignatureVerificationFailed","JWTClaimValidationFailed","JWSInvalid","JWTInvalid"
  ].includes(error.name);
}
function amountToMinor(value:unknown):string|null{
  if(typeof value!=="number" && typeof value!=="string") return null;
  const match=/^(0|[1-9]\d{0,12})(?:\.(\d{1,2}))?$/.exec(String(value));
  if(!match) return null;
  const whole=BigInt(match[1]);
  const fraction=BigInt((match[2]??"").padEnd(2,"0"));
  const minor=whole*100n+fraction;
  return minor>0n && minor<=BigInt(Number.MAX_SAFE_INTEGER) ? minor.toString() : null;
}

export function createFlutterwaveDepositStatusHandler(options:Options){
  const {pool,jwks,issuer,audience}=options;
  return async function handleFlutterwaveDepositStatus(req:IncomingMessage,res:ServerResponse):Promise<boolean>{
    const url=new URL(req.url??"/","http://localhost");
    const path=url.pathname.replace(/\/+$/,"")||"/";
    if(req.method!=="GET" || path!=="/customer/flutterwave/deposits/status") return false;
    if(!pool || !jwks || !issuer || !audience){
      send(res,503,{error:"FLUTTERWAVE_STATUS_SERVICE_NOT_CONFIGURED"}); return true;
    }
    const bearer=req.headers.authorization?.match(/^Bearer\s+(.+)$/i);
    if(!bearer){send(res,401,{error:"AUTHENTICATION_REQUIRED"});return true;}

    let userId:string;
    try{
      const {payload}=await jwtVerify(bearer[1],jwks,{algorithms:["EdDSA"],issuer,audience});
      if(typeof payload.sub!=="string" || !payload.sub){send(res,401,{error:"INVALID_SESSION"});return true;}
      const identity=await pool.query<{id:string}>(
        `SELECT app_user.id
           FROM neon_auth."user" auth_user
           JOIN public.fp_users app_user ON app_user.auth_subject=auth_user.id::text
          WHERE auth_user.id::text=$1 AND auth_user."emailVerified"=true
            AND app_user.status='active' AND app_user.role='customer'
          LIMIT 1`,[payload.sub]);
      if(identity.rowCount!==1){send(res,403,{error:"ACTIVE_VERIFIED_CUSTOMER_REQUIRED"});return true;}
      userId=identity.rows[0].id;
    }catch(error){
      if(isJwtError(error)) send(res,401,{error:"INVALID_SESSION"});
      else {
        console.error("FlowPay Flutterwave status authentication failed:",error instanceof Error?error.message:"database error");
        send(res,503,{error:"FLUTTERWAVE_STATUS_AUTH_UNAVAILABLE"});
      }
      return true;
    }

    const reference=url.searchParams.get("reference")?.trim()??"";
    const suppliedTransactionId=url.searchParams.get("transaction_id")?.trim()??"";
    if(!/^flowpay-flw-[0-9a-f-]{36}$/i.test(reference) ||
       (suppliedTransactionId && !/^\d{1,30}$/.test(suppliedTransactionId))){
      send(res,400,{error:"INVALID_FLUTTERWAVE_REFERENCE"});return true;
    }

    let deposit:Deposit;
    try{
      const result=await pool.query<Deposit>(
        `SELECT transaction_id,provider_tx_ref,provider_transaction_id,
                amount_minor::text AS amount_minor,currency,status,verified_at
           FROM public.fp_flutterwave_deposits
          WHERE user_id=$1 AND provider_tx_ref=$2
          LIMIT 1`,[userId,reference]);
      if(result.rowCount!==1 || !result.rows[0]){
        send(res,404,{error:"FLUTTERWAVE_DEPOSIT_NOT_FOUND"});return true;
      }
      deposit=result.rows[0];
    }catch(error){
      console.error("FlowPay Flutterwave deposit status read failed:",error instanceof Error?error.message:"database error");
      send(res,503,{error:"FLUTTERWAVE_STATUS_UNAVAILABLE"});return true;
    }

    if(deposit.status==="pending"){
      const secret=process.env.FLW_SECRET_KEY?.trim()??"";
      if(process.env.FLW_ENVIRONMENT!=="test" || !secret.startsWith("FLWSECK_TEST-") ||
         process.env.FLOWPAY_RUNTIME_ENV!=="development" || process.env.NODE_ENV==="production"){
        send(res,503,{error:"FLUTTERWAVE_SANDBOX_CONFIGURATION_REQUIRED"});return true;
      }
      const providerId=deposit.provider_transaction_id??suppliedTransactionId;
      if(providerId){
        let response:Response;
        let body:unknown;
        try{
          response=await fetch(`https://api.flutterwave.com/v3/transactions/${encodeURIComponent(providerId)}/verify`,{
            headers:{Authorization:"Bearer "+secret,Accept:"application/json"},
            signal:AbortSignal.timeout(12_000)
          });
          body=await response.json().catch(()=>null);
        }catch(error){
          console.error("FlowPay Flutterwave status verification failed:",error instanceof Error?error.message:"network error");
          send(res,503,{error:"FLUTTERWAVE_PROVIDER_VERIFICATION_UNAVAILABLE"});return true;
        }
        const root=record(body);
        const verified=record(root.data);
        const verifiedId=typeof verified.id==="number" && Number.isSafeInteger(verified.id)
          ? String(verified.id) : typeof verified.id==="string" && /^\d{1,30}$/.test(verified.id) ? verified.id : "";
        const verifiedAmount=amountToMinor(verified.amount);
        const verifiedReference=typeof verified.tx_ref==="string"?verified.tx_ref:"";
        if(response.ok && root.status==="success" && verified.status==="successful"){
          if(verifiedId!==providerId || verifiedReference!==deposit.provider_tx_ref ||
             verifiedAmount!==deposit.amount_minor || verified.currency!=="NGN"){
            send(res,202,{deposit:{reference:deposit.provider_tx_ref,amountMinor:deposit.amount_minor,
              currency:"NGN",status:"pending",verifiedAt:deposit.verified_at},
              error:"FLUTTERWAVE_PROVIDER_TRANSACTION_MISMATCH"});
            return true;
          }
          try{
            const digest=createHash("sha256").update(JSON.stringify(verified)).digest("hex");
            const settled=await settleVerifiedFlutterwaveDeposit(pool,{
              providerReference:deposit.provider_tx_ref,
              providerTransactionId:verifiedId,
              amountMinor:verifiedAmount,
              currency:"NGN",
              eventId:"verify:"+verifiedId,
              eventType:"transaction.verify",
              payloadSha256:digest
            });
            deposit={...deposit,status:settled.status,provider_transaction_id:verifiedId,verified_at:new Date().toISOString()};
          }catch(error){
            const code=error instanceof Error?error.message:"FLUTTERWAVE_SETTLEMENT_UNAVAILABLE";
            console.error("FlowPay Flutterwave status settlement failed:",code);
            send(res,503,{error:code==="FLUTTERWAVE_CLEARING_ACCOUNT_NOT_CONFIGURED"?code:"FLUTTERWAVE_SETTLEMENT_UNAVAILABLE"});
            return true;
          }
        }
      }
    }
    send(res,200,{
      deposit:{
        reference:deposit.provider_tx_ref,
        amountMinor:deposit.amount_minor,
        currency:deposit.currency.trim(),
        status:deposit.status,
        verifiedAt:deposit.verified_at
      },
      providerVerified:deposit.status==="posted" || Boolean(deposit.provider_transaction_id),
      walletCredited:deposit.status==="posted"
    });
    return true;
  };
}
