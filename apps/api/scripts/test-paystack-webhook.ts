import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { createPaystackWebhookHandler } from "../src/paystack-webhook.js";

const originalFetch=globalThis.fetch;
const original={env:process.env.PAYSTACK_ENVIRONMENT,key:process.env.PAYSTACK_SECRET_KEY};
function setup(opts:{duplicate?:boolean;amount?:number;verifiedAmount?:number;domain?:string}={}){
 process.env.PAYSTACK_ENVIRONMENT="test";process.env.PAYSTACK_SECRET_KEY="sk_test_unit_test_secret";
 const queries:string[]=[];let connections=0;
 const client={query:async(sql:string)=>{queries.push(sql);
  if(sql.includes("SELECT transaction_id,reference"))return{rowCount:1,rows:[{transaction_id:"00000000-0000-4000-8000-000000000001",reference:"flowpay_ps_test_ref",provider_transaction_id:null,amount_minor:"250000",currency:"NGN",status:"pending"}]};
  if(sql.includes("INSERT INTO public.fp_payment_events"))return{rowCount:opts.duplicate?0:1,rows:opts.duplicate?[]:[{provider_event_id:"flowpay_ps_test_ref"}]};
  return{rowCount:1,rows:[]};},release:()=>undefined};
 const pool={connect:async()=>{connections++;return client;}} as unknown as Pool;
 globalThis.fetch=async()=>new Response(JSON.stringify({status:true,data:{id:123456789,domain:opts.domain??"test",status:"success",reference:"flowpay_ps_test_ref",amount:opts.verifiedAmount??250000,currency:"NGN"}}),{status:200});
 const payload={event:"charge.success",data:{id:123456789,reference:"flowpay_ps_test_ref",status:"success",amount:opts.amount??250000,currency:"NGN"}};
 const raw=Buffer.from(JSON.stringify(payload));
 const request=(signature=createHmac("sha512",process.env.PAYSTACK_SECRET_KEY!).update(raw).digest("hex"))=>
  Object.assign(Readable.from([raw]),{method:"POST",url:"/webhooks/paystack",headers:{"x-paystack-signature":signature}}) as unknown as IncomingMessage;
 const response=()=>{let status=0,body="";const res={writeHead:(s:number)=>{status=s;},end:(v?:string)=>{body=v??"";}} as unknown as ServerResponse;return{res,result:()=>({status,body:body?JSON.parse(body):null})};};
 return{pool,queries,request,response,connections:()=>connections};
}
test("valid test charge is verified but never credits the wallet",async()=>{
 const c=setup();const r=c.response();await createPaystackWebhookHandler({pool:c.pool})(c.request(),r.res);
 assert.equal(r.result().status,200);assert.equal(r.result().body.providerVerified,true);assert.equal(r.result().body.walletCredited,false);
 assert.ok(c.queries.some(q=>q.includes("INSERT INTO public.fp_payment_events")));
});
test("invalid signature is rejected before provider verification or DB access",async()=>{
 const c=setup();const r=c.response();await createPaystackWebhookHandler({pool:c.pool})(c.request("bad"),r.res);
 assert.equal(r.result().status,401);assert.equal(c.connections(),0);
});
test("amount mismatch is rejected before DB access",async()=>{
 const c=setup({amount:250000,verifiedAmount:249999});const r=c.response();await createPaystackWebhookHandler({pool:c.pool})(c.request(),r.res);
 assert.equal(r.result().status,202);assert.equal(r.result().body.reason,"PROVIDER_EVENT_MISMATCH");assert.equal(c.connections(),0);
});
test("non-test provider transaction is rejected",async()=>{
 const c=setup({domain:"live"});const r=c.response();await createPaystackWebhookHandler({pool:c.pool})(c.request(),r.res);
 assert.equal(r.result().status,202);assert.equal(c.connections(),0);
});
test("duplicate event is acknowledged without repeating deposit writes",async()=>{
 const c=setup({duplicate:true});const r=c.response();await createPaystackWebhookHandler({pool:c.pool})(c.request(),r.res);
 assert.equal(r.result().status,200);assert.equal(r.result().body.duplicate,true);assert.equal(r.result().body.walletCredited,false);
 assert.equal(c.queries.some(q=>q.includes("UPDATE public.fp_paystack_deposits")),false);
});
process.on("exit",()=>{globalThis.fetch=originalFetch;if(original.env===undefined)delete process.env.PAYSTACK_ENVIRONMENT;else process.env.PAYSTACK_ENVIRONMENT=original.env;if(original.key===undefined)delete process.env.PAYSTACK_SECRET_KEY;else process.env.PAYSTACK_SECRET_KEY=original.key;});
