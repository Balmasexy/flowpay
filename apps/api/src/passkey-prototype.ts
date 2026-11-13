import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Pool, type PoolClient } from "pg";
import { betterAuth } from "better-auth";
import { toNodeHandler, fromNodeHeaders } from "better-auth/node";
import { passkey } from "@better-auth/passkey";
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON
} from "@simplewebauthn/server";

const scrypt = promisify(scryptCallback);
const AUTH_PATH = "/prototype-auth";
const SECURITY_PATH = "/prototype-security";
const MAX_BODY_BYTES = 180_000;
const MAX_AMOUNT_MINOR = BigInt(Number.MAX_SAFE_INTEGER);

type JsonRecord = Record<string, unknown>;
type TransferContext = {
  accountNumber: string;
  bankCode: string;
  amountMinor: string;
  idempotencyKey: string;
};
type PasskeyRow = {
  credential_id: string;
  public_key: string;
  counter: string | number;
  transports: string | null;
};
type Options = {
  auth: ReturnType<typeof betterAuth>;
  pool: Pool;
  handler: ReturnType<typeof toNodeHandler>;
  rpID: string;
  origin: string;
};

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status);
  res.end(JSON.stringify(body));
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

async function readJson(req: IncomingMessage): Promise<JsonRecord> {
  let raw = "";
  for await (const chunk of req) {
    raw += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) throw new Error("PAYLOAD_TOO_LARGE");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw || "{}"); } catch { throw new Error("INVALID_JSON"); }
  const body = asRecord(parsed);
  if (!body) throw new Error("INVALID_PAYLOAD");
  return body;
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function isValidPasskeyPrototypeTransferContext(value: unknown): value is TransferContext {
  const body = asRecord(value);
  if (!body) return false;
  if (Object.keys(body).some(key => !["accountNumber", "bankCode", "amountMinor", "idempotencyKey"].includes(key))) return false;
  if (typeof body.accountNumber !== "string" || !/^\d{10}$/.test(body.accountNumber)) return false;
  if (typeof body.bankCode !== "string" || !/^[A-Za-z0-9_-]{2,12}$/.test(body.bankCode)) return false;
  if (typeof body.amountMinor !== "string" || !/^\d{1,15}$/.test(body.amountMinor)) return false;
  try {
    const amount = BigInt(body.amountMinor);
    if (amount <= 0n || amount > MAX_AMOUNT_MINOR) return false;
  } catch { return false; }
  return validUuid(body.idempotencyKey);
}

/** Exposed for deterministic unit tests; account numbers are hashed, never stored in challenge rows. */
export function passkeyPrototypeContextHash(context: TransferContext): string {
  return createHash("sha256").update([
    "flowpay-bank-transfer-v1",
    context.accountNumber,
    context.bankCode,
    context.amountMinor,
    context.idempotencyKey
  ].join("\n"), "utf8").digest("hex");
}

export function isValidPasskeyPrototypePin(value: unknown): value is string {
  return typeof value === "string" && /^\d{6}$/.test(value);
}

async function derivePin(pin: string, salt: Buffer): Promise<Buffer> {
  return await scrypt(pin, salt, 64) as Buffer;
}

function credentialTransports(value: string | null): string[] {
  if (!value) return [];
  return value.split(",").map(item => item.trim()).filter(Boolean);
}

async function getSession(options: Options, req: IncomingMessage) {
  return await options.auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
}

async function recordEvent(
  pool: Pool, userId: string, eventType: string,
  outcome: "succeeded" | "failed" | "rejected", details: JsonRecord = {}
): Promise<void> {
  await pool.query(
    `INSERT INTO security_events (user_id,event_type,outcome,details)
     VALUES ($1,$2,$3,$4::jsonb)`,
    [userId,eventType,outcome,JSON.stringify(details)]
  );
}

async function ensureSession(options: Options, req: IncomingMessage, res: ServerResponse) {
  const session = await getSession(options, req);
  if (!session?.user?.id) {
    send(res, 401, { error: "PROTOTYPE_AUTHENTICATION_REQUIRED" });
    return null;
  }
  return session;
}

async function setupTransactionPin(
  options: Options, req: IncomingMessage, res: ServerResponse, userId: string
): Promise<void> {
  let body: JsonRecord;
  try { body = await readJson(req); } catch (error) {
    const message = error instanceof Error ? error.message : "INVALID_PAYLOAD";
    send(res, message === "PAYLOAD_TOO_LARGE" ? 413 : 400, { error: message });
    return;
  }
  if (Object.keys(body).some(key => key !== "transactionPin") || !isValidPasskeyPrototypePin(body.transactionPin)) {
    send(res, 400, { error: "SIX_DIGIT_TRANSACTION_PIN_REQUIRED" });
    return;
  }
  const exists = await options.pool.query(
    "SELECT 1 FROM transaction_pin WHERE user_id=$1",
    [userId]
  );
  if (exists.rowCount) {
    send(res, 409, { error: "TRANSACTION_PIN_ALREADY_SET" });
    return;
  }
  const salt = randomBytes(16);
  const hash = await derivePin(body.transactionPin, salt);
  try {
    await options.pool.query(
      `INSERT INTO transaction_pin(user_id,salt,pin_hash)
       VALUES($1,$2,$3)`,
      [userId,salt,hash]
    );
    await recordEvent(options.pool,userId,"transaction_pin_created","succeeded");
    send(res,201,{configured:true,message:"Your separate six-digit transaction PIN has been configured for this test account."});
  } catch (error) {
    console.error("Passkey prototype PIN setup failed:", error instanceof Error ? error.message : "database error");
    send(res,503,{error:"TRANSACTION_PIN_SETUP_UNAVAILABLE"});
  }
}

async function startTransactionChallenge(
  options: Options, req: IncomingMessage, res: ServerResponse, userId: string
): Promise<void> {
  let body: JsonRecord;
  try { body = await readJson(req); } catch (error) {
    const message = error instanceof Error ? error.message : "INVALID_PAYLOAD";
    send(res, message === "PAYLOAD_TOO_LARGE" ? 413 : 400, { error: message });
    return;
  }
  if (!isValidPasskeyPrototypeTransferContext(body)) {
    send(res,400,{error:"INVALID_TRANSFER_REVIEW_DETAILS"});
    return;
  }
  const pin = await options.pool.query("SELECT 1 FROM transaction_pin WHERE user_id=$1",[userId]);
  if (!pin.rowCount) {
    send(res,403,{error:"TRANSACTION_PIN_SETUP_REQUIRED"});
    return;
  }
  const credentials = await options.pool.query<PasskeyRow>(
    `SELECT "credentialID" AS credential_id, "publicKey" AS public_key,
            counter, transports
       FROM passkey
      WHERE "userId"=$1
      ORDER BY "createdAt" DESC
      LIMIT 25`,
    [userId]
  );
  if (!credentials.rowCount) {
    send(res,403,{error:"PASSKEY_ENROLLMENT_REQUIRED"});
    return;
  }
  const publicKeyOptions = await generateAuthenticationOptions({
    rpID: options.rpID,
    userVerification: "required",
    allowCredentials: credentials.rows.map(credential => ({
      id: credential.credential_id,
      transports: credentialTransports(credential.transports) as never
    }))
  });
  const challengeId = randomUUID();
  const transferHash = passkeyPrototypeContextHash(body);
  await options.pool.query(
    `INSERT INTO transaction_challenges(id,user_id,challenge,context_hash,expires_at)
     VALUES($1,$2,$3,$4,NOW()+INTERVAL '5 minutes')`,
    [challengeId,userId,publicKeyOptions.challenge,transferHash]
  );
  send(res,200,{
    challengeId,
    options:publicKeyOptions,
    expiresInSeconds:300,
    userVerification:"required",
    message:"Review the transfer details, then verify with your device passkey."
  });
}

async function verifyTransactionApproval(
  options: Options, req: IncomingMessage, res: ServerResponse, userId: string
): Promise<void> {
  let body: JsonRecord;
  try { body = await readJson(req); } catch (error) {
    const message = error instanceof Error ? error.message : "INVALID_PAYLOAD";
    send(res, message === "PAYLOAD_TOO_LARGE" ? 413 : 400, { error: message });
    return;
  }
  const context = {
    accountNumber: body.accountNumber,
    bankCode: body.bankCode,
    amountMinor: body.amountMinor,
    idempotencyKey: body.idempotencyKey
  };
  if (!isValidPasskeyPrototypeTransferContext(context) || !validUuid(body.challengeId) ||
      !isValidPasskeyPrototypePin(body.transactionPin) || !asRecord(body.response) ||
      Object.keys(body).some(key => ![
        "accountNumber","bankCode","amountMinor","idempotencyKey",
        "challengeId","transactionPin","response"
      ].includes(key))) {
    send(res,400,{error:"INVALID_TRANSACTION_AUTHORIZATION_DETAILS"});
    return;
  }
  const client = await options.pool.connect();
  let committed = false;
  try {
    await client.query("BEGIN");
    const pin = await client.query<{
      salt: Buffer; pin_hash: Buffer; failed_attempts: number; locked_until: Date | null;
    }>(
      `SELECT salt,pin_hash,failed_attempts,locked_until
         FROM transaction_pin WHERE user_id=$1 FOR UPDATE`,
      [userId]
    );
    if (pin.rowCount !== 1) throw new Error("TRANSACTION_PIN_SETUP_REQUIRED");
    const pinState = pin.rows[0];
    if (pinState.locked_until && pinState.locked_until.getTime() > Date.now()) {
      throw new Error("TRANSACTION_PIN_TEMPORARILY_LOCKED");
    }
    const candidate = await derivePin(body.transactionPin,pinState.salt);
    if (candidate.length !== pinState.pin_hash.length || !timingSafeEqual(candidate,pinState.pin_hash)) {
      const failures = pinState.failed_attempts + 1;
      await client.query(
        `UPDATE transaction_pin SET failed_attempts=$2,
          locked_until=CASE WHEN $2>=5 THEN NOW()+INTERVAL '15 minutes' ELSE NULL END,
          updated_at=NOW() WHERE user_id=$1`,
        [userId,failures]
      );
      await client.query("COMMIT");
      committed = true;
      await recordEvent(options.pool,userId,"transaction_pin_verification","failed",{attempt:failures});
      send(res,401,{error:failures>=5?"TRANSACTION_PIN_TEMPORARILY_LOCKED":"INVALID_TRANSACTION_PIN"});
      return;
    }

    const storedChallenge = await client.query<{
      challenge:string; context_hash:string;
    }>(
      `SELECT challenge,context_hash FROM transaction_challenges
        WHERE id=$1 AND user_id=$2 AND consumed_at IS NULL AND expires_at>NOW()
        FOR UPDATE`,
      [body.challengeId,userId]
    );
    if (storedChallenge.rowCount !== 1) throw new Error("PASSKEY_CHALLENGE_EXPIRED_OR_USED");
    if (storedChallenge.rows[0].context_hash.trim() !== passkeyPrototypeContextHash(context)) {
      throw new Error("PASSKEY_TRANSFER_DETAILS_CHANGED");
    }

    const credentialId = typeof (body.response as JsonRecord).id === "string"
      ? String((body.response as JsonRecord).id) : "";
    if (!credentialId) throw new Error("PASSKEY_CREDENTIAL_REQUIRED");
    const credential = await client.query<PasskeyRow>(
      `SELECT "credentialID" AS credential_id, "publicKey" AS public_key,
              counter, transports
         FROM passkey
        WHERE "userId"=$1 AND "credentialID"=$2
        FOR UPDATE`,
      [userId,credentialId]
    );
    if (credential.rowCount !== 1) throw new Error("PASSKEY_NOT_REGISTERED");
    const saved = credential.rows[0];
    const verification = await verifyAuthenticationResponse({
      response: body.response as unknown as AuthenticationResponseJSON,
      expectedChallenge: storedChallenge.rows[0].challenge,
      expectedOrigin: options.origin,
      expectedRPID: options.rpID,
      credential: {
        id:saved.credential_id,
        publicKey:new Uint8Array(Buffer.from(saved.public_key,"base64")),
        counter:Number(saved.counter),
        transports:credentialTransports(saved.transports) as never
      }
    });
    if (!verification.verified || !verification.authenticationInfo.userVerified) {
      throw new Error("PASSKEY_USER_VERIFICATION_FAILED");
    }
    await client.query(
      `UPDATE passkey SET counter=$2 WHERE "credentialID"=$1`,
      [credentialId,verification.authenticationInfo.newCounter]
    );
    await client.query(
      `UPDATE transaction_pin SET failed_attempts=0,locked_until=NULL,updated_at=NOW()
       WHERE user_id=$1`,
      [userId]
    );
    await client.query(
      `UPDATE transaction_challenges SET consumed_at=NOW()
       WHERE id=$1 AND consumed_at IS NULL`,
      [body.challengeId]
    );
    await client.query(
      `INSERT INTO security_events(user_id,event_type,outcome,details)
       VALUES($1,'bank_transfer_step_up_verified','succeeded',$2::jsonb)`,
      [userId,JSON.stringify({
        amountMinor:context.amountMinor,
        bankCode:context.bankCode,
        accountNumberLast4:context.accountNumber.slice(-4),
        credentialId
      })]
    );
    await client.query("COMMIT");
    committed = true;
    send(res,200,{
      authorized:true,
      transactionPinVerified:true,
      passkeyVerified:true,
      userVerification:"verified",
      expiresInSeconds:0,
      transferSubmitted:false,
      status:"prototype_authorized_only",
      message:"Both factors were verified. This isolated prototype does not submit or move money."
    });
  } catch (error) {
    if (!committed) await client.query("ROLLBACK").catch(()=>undefined);
    const code = error instanceof Error ? error.message : "TRANSACTION_AUTHORIZATION_FAILED";
    if ([
      "TRANSACTION_PIN_SETUP_REQUIRED","TRANSACTION_PIN_TEMPORARILY_LOCKED",
      "PASSKEY_CHALLENGE_EXPIRED_OR_USED","PASSKEY_TRANSFER_DETAILS_CHANGED",
      "PASSKEY_CREDENTIAL_REQUIRED","PASSKEY_NOT_REGISTERED","PASSKEY_USER_VERIFICATION_FAILED"
    ].includes(code)) {
      await recordEvent(options.pool,userId,"bank_transfer_step_up_verified","rejected",{reason:code}).catch(()=>undefined);
      send(res,code==="TRANSACTION_PIN_TEMPORARILY_LOCKED"?429:401,{error:code});
    } else {
      console.error("Passkey prototype transaction approval failed:",code);
      send(res,503,{error:"TRANSACTION_AUTHORIZATION_UNAVAILABLE"});
    }
  } finally {
    client.release();
  }
}

async function getTransactionPinStatus(options: Options, userId: string, res: ServerResponse) {
  try {
    const result=await options.pool.query<{locked_until:Date|null}>(
      "SELECT locked_until FROM transaction_pin WHERE user_id=$1",[userId]);
    send(res,200,{
      configured:result.rowCount===1,
      locked:result.rowCount===1 && Boolean(result.rows[0].locked_until && result.rows[0].locked_until.getTime()>Date.now())
    });
  } catch {
    send(res,503,{error:"TRANSACTION_PIN_STATUS_UNAVAILABLE"});
  }
}

export function createPasskeyPrototypeService() {
  const databaseUrl=process.env.FLOWPAY_PASSKEY_DATABASE_URL?.trim();
  const secret=process.env.FLOWPAY_PASSKEY_AUTH_SECRET?.trim();
  const baseURL=process.env.FLOWPAY_PASSKEY_AUTH_BASE_URL?.trim().replace(/\/+$/,"");
  const origin=process.env.FLOWPAY_PASSKEY_FRONTEND_ORIGIN?.trim().replace(/\/+$/,"");
  const rpID=process.env.FLOWPAY_PASSKEY_RP_ID?.trim();
  const explicitlyEnabled=process.env.FLOWPAY_PASSKEY_ENABLED==="true";
  let service: Options | null = null;
  let disabledReason="FLOWPAY_PASSKEY_PROTOTYPE_NOT_CONFIGURED";

  if (explicitlyEnabled && databaseUrl && secret && secret.length>=32 && baseURL && origin && rpID) {
    const pool = new Pool({
      connectionString:databaseUrl,
      max:4,
      idleTimeoutMillis:10_000,
      connectionTimeoutMillis:5_000,
      options:"-c search_path=passkey_auth,public"
    });
    pool.on("error",error=>console.error("Passkey prototype database pool error:",error.message));
    const auth=betterAuth({
      appName:"FlowPay Passkey Prototype",
      baseURL,
      basePath:AUTH_PATH,
      secret,
      database:pool,
      trustedOrigins:[origin],
      emailAndPassword:{
        enabled:true,
        minPasswordLength:10,
        maxPasswordLength:128,
        requireEmailVerification:false
      },
      plugins:[
        passkey({
          rpName:"FlowPay",
          rpID,
          origin,
          authenticatorSelection:{
            authenticatorAttachment:"platform",
            residentKey:"required",
            userVerification:"required"
          }
        })
      ],
      advanced:{
        defaultCookieAttributes:{
          sameSite:"lax",
          secure:baseURL.startsWith("https://"),
          httpOnly:true
        }
      }
    });
    service={auth,pool,handler:toNodeHandler(auth),rpID,origin};
    disabledReason="";
  }

  async function handleAuth(req:IncomingMessage,res:ServerResponse):Promise<boolean>{
    const path=new URL(req.url??"/","http://localhost").pathname;
    if(!path.startsWith(AUTH_PATH+"/") && path!==AUTH_PATH) return false;
    if(!service){
      send(res,503,{error:disabledReason});
      return true;
    }
    await service.handler(req,res);
    return true;
  }

  async function handleSecurity(req:IncomingMessage,res:ServerResponse):Promise<boolean>{
    const url=new URL(req.url??"/","http://localhost");
    const path=url.pathname.replace(/\/+$/,"")||"/";
    if(!path.startsWith(SECURITY_PATH)) return false;
    if(!service){
      send(res,503,{error:disabledReason});
      return true;
    }
    if (req.headers.origin !== service.origin) {
      send(res,403,{error:"PASSKEY_PROTOTYPE_ORIGIN_NOT_ALLOWED"});
      return true;
    }
    const session=await ensureSession(service,req,res);
    if(!session) return true;
    const userId=session.user.id;
    if(req.method==="GET" && path===SECURITY_PATH+"/transaction-pin/status"){
      await getTransactionPinStatus(service,userId,res);
      return true;
    }
    if(req.method==="POST" && path===SECURITY_PATH+"/transaction-pin/setup"){
      await setupTransactionPin(service,req,res,userId);
      return true;
    }
    if(req.method==="POST" && path===SECURITY_PATH+"/transaction/options"){
      await startTransactionChallenge(service,req,res,userId);
      return true;
    }
    if(req.method==="POST" && path===SECURITY_PATH+"/transaction/verify"){
      await verifyTransactionApproval(service,req,res,userId);
      return true;
    }
    if(req.method==="GET" && path===SECURITY_PATH+"/status"){
      const [passkeys,pin]=await Promise.all([
        service.pool.query("SELECT COUNT(*)::int AS count FROM passkey WHERE \"userId\"=$1",[userId]),
        service.pool.query("SELECT 1 FROM transaction_pin WHERE user_id=$1",[userId])
      ]);
      send(res,200,{
        configured:true,
        passkeyCount:Number((passkeys.rows[0] as {count:number}).count),
        transactionPinConfigured:pin.rowCount===1,
        transactionVerification:"passkey plus transaction PIN",
        transferSubmissionEnabled:false
      });
      return true;
    }
    send(res,404,{error:"PASSKEY_PROTOTYPE_ROUTE_NOT_FOUND"});
    return true;
  }

  return {handleAuth,handleSecurity,enabled:Boolean(service)};
}
