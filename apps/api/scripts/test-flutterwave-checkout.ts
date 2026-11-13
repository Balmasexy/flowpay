import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { Readable } from "node:stream";
import { test, after } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { createLocalJWKSet, SignJWT } from "jose";
import { createFlutterwaveCheckoutHandler } from "../src/flutterwave-checkout.js";

const originalFetch=globalThis.fetch;
const originalEnv={
  nodeEnv:process.env.NODE_ENV,
  runtime:process.env.FLOWPAY_RUNTIME_ENV,
  environment:process.env.FLW_ENVIRONMENT,
  secret:process.env.FLW_SECRET_KEY,
  webhook:process.env.FLW_WEBHOOK_SECRET_HASH,
  redirect:process.env.FLW_REDIRECT_URL,
  min:process.env.FLW_DEPOSIT_MIN_MINOR,
  max:process.env.FLW_DEPOSIT_MAX_MINOR
};
const pair=generateKeyPairSync("ed25519");
const jwk=pair.publicKey.export({format:"jwk"});
const jwks=createLocalJWKSet({keys:[{...jwk,kid:"flowpay-flw-checkout-test",alg:"EdDSA",use:"sig"}]});
const userId="00000000-0000-4000-8000-000000000001";
const accountId="00000000-0000-4000-8000-000000000002";
const transactionId="00000000-0000-4000-8000-000000000003";
const idempotencyKey="00000000-0000-4000-8000-000000000004";

async function setup(options:{duplicate?:boolean;prerequisites?:boolean}={}){
  process.env.NODE_ENV="test";
  process.env.FLOWPAY_RUNTIME_ENV="development";
  process.env.FLW_ENVIRONMENT="test";
  process.env.FLW_SECRET_KEY="FLWSECK_TEST-unit-test";
  process.env.FLW_WEBHOOK_SECRET_HASH="unit-test-webhook-hash";
  process.env.FLW_REDIRECT_URL="https://flowpay-test.example.com/payment-return/flutterwave";
  process.env.FLW_DEPOSIT_MIN_MINOR="100";
  process.env.FLW_DEPOSIT_MAX_MINOR="50000000";
  const token=await new SignJWT({})
    .setProtectedHeader({alg:"EdDSA",kid:"flowpay-flw-checkout-test"})
    .setIssuer("https://flowpay.test")
    .setAudience("flowpay-api")
    .setSubject("test-neon-auth-subject")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(pair.privateKey);
  const queries:Array<{sql:string;values?:unknown[]}>= [];
  let providerCalls=0;
  const client={
    query:async(sql:string,values?:unknown[])=>{
      queries.push({sql,values});
      if(sql.includes("settlementPrerequisites")) return {rowCount:1,rows:[]};
      if(sql.includes("AS \"eventTable\"")){
        return {rowCount:1,rows:[{clearing:options.prerequisites!==false,eventTable:options.prerequisites!==false}]};
      }
      if(sql.includes("FROM public.fp_accounts") && sql.includes("account_type = 'customer'")){
        return {rowCount:1,rows:[{id:accountId}]};
      }
      if(sql.includes("INSERT INTO public.fp_ledger_transactions")){
        return options.duplicate ? {rowCount:0,rows:[]} : {rowCount:1,rows:[{id:transactionId}]};
      }
      if(sql.includes("SELECT t.id, d.checkout_url")){
        return {rowCount:1,rows:[{id:transactionId,checkout_url:"https://checkout.flutterwave.com/v3/hosted/pay/saved",status:"pending",amount_minor:"250000"}]};
      }
      if(sql.includes("INSERT INTO public.fp_flutterwave_deposits")) return {rowCount:1,rows:[]};
      if(sql.includes("UPDATE public.fp_flutterwave_deposits")) return {rowCount:1,rows:[]};
      return {rowCount:1,rows:[]};
    },
    release:()=>undefined
  };
  const pool={
    query:async(sql:string,values?:unknown[])=>{
      queries.push({sql,values});
      if(sql.includes('FROM neon_auth."user"')) {
        return {rowCount:1,rows:[{id:userId,email:"sandbox-customer@example.test",name:"Sandbox Customer"}]};
      }
      if(sql.includes("UPDATE public.fp_flutterwave_deposits")) return {rowCount:1,rows:[]};
      throw new Error("Unexpected pool query: "+sql);
    },
    connect:async()=>client
  } as unknown as Pool;
  globalThis.fetch=async(input:string|URL|Request)=>{
    providerCalls++;
    const url=String(input);
    assert.equal(url,"https://api.flutterwave.com/v3/payments");
    return new Response(JSON.stringify({
      status:"success",
      data:{link:"https://checkout.flutterwave.com/v3/hosted/pay/provider-session"}
    }),{status:200,headers:{"content-type":"application/json"}});
  };
  const request=(body:Record<string,unknown>)=>Object.assign(
    Readable.from([Buffer.from(JSON.stringify(body))]),
    {method:"POST",url:"/customer/flutterwave/deposits",headers:{authorization:"Bearer "+token}}
  ) as unknown as IncomingMessage;
  const response=()=>{
    let statusCode=0;let body="";
    const res={
      writeHead:(status:number)=>{statusCode=status;},
      end:(value?:string)=>{body=value??"";}
    } as unknown as ServerResponse;
    return {res,result:()=>({statusCode,body:body?JSON.parse(body):null})};
  };
  return {pool,queries,request,response,getProviderCalls:()=>providerCalls};
}

test("creates a Flutterwave sandbox checkout after persisting idempotency and provider references",async()=>{
  const ctx=await setup();
  const res=ctx.response();
  await createFlutterwaveCheckoutHandler({
    pool:ctx.pool,jwks:jwks as unknown as ReturnType<typeof import("jose").createRemoteJWKSet>,
    issuer:"https://flowpay.test",audience:"flowpay-api"
  })(ctx.request({amountMinor:"250000",idempotencyKey}),res.res);
  const result=res.result();
  assert.equal(result.statusCode,201);
  assert.equal(result.body.environment,"test");
  assert.equal(result.body.checkoutUrl,"https://checkout.flutterwave.com/v3/hosted/pay/provider-session");
  const insert=ctx.queries.find(item=>item.sql.includes("INSERT INTO public.fp_flutterwave_deposits"));
  assert.ok(insert);
  assert.ok(insert.sql.includes("idempotency_key"));
  assert.ok(insert.sql.includes("provider_reference"));
  assert.ok(insert.sql.includes("provider_tx_ref"));
  assert.equal(insert.values?.[3],"flutterwave-deposit:"+userId+":"+idempotencyKey);
  assert.equal(insert.values?.[4],result.body.providerReference);
  assert.equal(insert.values?.[5],"250000");
  assert.equal(ctx.getProviderCalls(),1);
});

test("returns the same saved checkout for an idempotent retry",async()=>{
  const ctx=await setup({duplicate:true});
  const res=ctx.response();
  await createFlutterwaveCheckoutHandler({
    pool:ctx.pool,jwks:jwks as unknown as ReturnType<typeof import("jose").createRemoteJWKSet>,
    issuer:"https://flowpay.test",audience:"flowpay-api"
  })(ctx.request({amountMinor:"250000",idempotencyKey}),res.res);
  assert.equal(res.result().statusCode,200);
  assert.equal(res.result().body.checkoutUrl,"https://checkout.flutterwave.com/v3/hosted/pay/saved");
  assert.equal(ctx.getProviderCalls(),0);
});

test("does not create a provider checkout when settlement prerequisites are missing",async()=>{
  const ctx=await setup({prerequisites:false});
  const res=ctx.response();
  await createFlutterwaveCheckoutHandler({
    pool:ctx.pool,jwks:jwks as unknown as ReturnType<typeof import("jose").createRemoteJWKSet>,
    issuer:"https://flowpay.test",audience:"flowpay-api"
  })(ctx.request({amountMinor:"250000",idempotencyKey}),res.res);
  assert.equal(res.result().statusCode,503);
  assert.equal(res.result().body.error,"FLUTTERWAVE_SETTLEMENT_NOT_CONFIGURED");
  assert.equal(ctx.getProviderCalls(),0);
  assert.equal(ctx.queries.some(item=>item.sql.includes("INSERT INTO public.fp_ledger_transactions")),false);
});

test("blocks Flutterwave sandbox checkout on a production API",async()=>{
  const ctx=await setup();
  process.env.NODE_ENV="production";
  const res=ctx.response();
  await createFlutterwaveCheckoutHandler({
    pool:ctx.pool,jwks:jwks as unknown as ReturnType<typeof import("jose").createRemoteJWKSet>,
    issuer:"https://flowpay.test",audience:"flowpay-api"
  })(ctx.request({amountMinor:"250000",idempotencyKey}),res.res);
  assert.equal(res.result().statusCode,503);
  assert.equal(res.result().body.error,"FLUTTERWAVE_SANDBOX_CONFIGURATION_REQUIRED");
  assert.equal(ctx.getProviderCalls(),0);
});

after(()=>{
  globalThis.fetch=originalFetch;
  const restore=(envKey:string,value:string|undefined)=>{
    if(value===undefined) delete process.env[envKey]; else process.env[envKey]=value;
  };
  restore("NODE_ENV",originalEnv.nodeEnv);
  restore("FLOWPAY_RUNTIME_ENV",originalEnv.runtime);
  restore("FLW_ENVIRONMENT",originalEnv.environment);
  restore("FLW_SECRET_KEY",originalEnv.secret);
  restore("FLW_WEBHOOK_SECRET_HASH",originalEnv.webhook);
  restore("FLW_REDIRECT_URL",originalEnv.redirect);
  restore("FLW_DEPOSIT_MIN_MINOR",originalEnv.min);
  restore("FLW_DEPOSIT_MAX_MINOR",originalEnv.max);
});
