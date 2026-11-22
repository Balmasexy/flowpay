import { useCallback, useEffect, useState } from "react";
import { Building2, Check, Copy, FileText, RefreshCw, ShieldCheck, Smartphone, Wallet } from "lucide-react";

type WalletAccount = { currency: string; status: string; createdAt: string };
type AccountDetails = {
  flowpayAccountNumber: string | null;
  phoneNumber: string | null;
  phoneAliasVerified: boolean;
  walletAccounts: WalletAccount[];
  message: string;
};

type PaystackDva = {
  environment: "test" | "live";
  assignmentEnabled: boolean;
  livePaymentsEnabled: boolean;
  account: {
    assigned: boolean;
    status: string;
    accountNumber: string | null;
    bankName: string | null;
    accountName: string | null;
  };
  message: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function parseAccountDetails(value: unknown): AccountDetails | null {
  const body = asRecord(value);
  if (!body || !Array.isArray(body.walletAccounts)) return null;
  const wallets: WalletAccount[] = [];
  for (const raw of body.walletAccounts) {
    const row = asRecord(raw);
    if (!row || typeof row.currency !== "string" || !/^[A-Z]{3}$/.test(row.currency) ||
        typeof row.status !== "string" || typeof row.createdAt !== "string" ||
        !Number.isFinite(Date.parse(row.createdAt))) return null;
    wallets.push({
      currency: row.currency,
      status: row.status.slice(0, 30),
      createdAt: row.createdAt
    });
  }
  const flowpayAccountNumber = typeof body.flowpayAccountNumber === "string" &&
    /^[1-9][0-9]{9}$/.test(body.flowpayAccountNumber) ? body.flowpayAccountNumber : null;
  const phoneNumber = body.phoneAliasVerified === true && typeof body.phoneNumber === "string" &&
    /^\+234[789][0-9]{9}$/.test(body.phoneNumber) ? body.phoneNumber : null;
  return {
    flowpayAccountNumber,
    phoneNumber,
    phoneAliasVerified: phoneNumber !== null,
    walletAccounts: wallets,
    message: typeof body.message === "string" ? body.message.slice(0, 300) : "Account information is read-only."
  };
}

function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleDateString();
}

export default function CustomerAccountDetails({ token, go }: { token: string; go?: (path: string) => void }) {
  const [copied, setCopied] = useState("");
  const [data, setData] = useState<AccountDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [paystackDva, setPaystackDva] = useState<PaystackDva | null>(null);
  const [paystackDvaLoading, setPaystackDvaLoading] = useState(true);
  const [paystackDvaError, setPaystackDvaError] = useState("");

  const copyFlowPayId = async () => {
    if (!data?.flowpayAccountNumber) return;
    try {
      await navigator.clipboard.writeText(data.flowpayAccountNumber);
      setCopied("FlowPay ID copied");
    } catch {
      setCopied("Clipboard unavailable");
    }
  };

  const copyPhoneNumber = async () => {
    if (!data?.phoneNumber) return;
    try {
      await navigator.clipboard.writeText(data.phoneNumber);
      setCopied("Verified FlowPay phone number copied");
    } catch {
      setCopied("Clipboard unavailable");
    }
  };

  const copyPaystackAccount = async () => {
    const number = paystackDva?.account.accountNumber;
    if (!number) return;
    try {
      await navigator.clipboard.writeText(number);
      setCopied("Paystack receiving account number copied");
    } catch {
      setCopied("Clipboard unavailable");
    }
  };

  const load = useCallback(async () => {
    if (!token || token.split(".").length !== 3) {
      setData(null);
      setError("Your secure session is not ready. Sign in again and retry.");
      setLoading(false);
      return;
    }
    const apiBase = String(import.meta.env.VITE_API_BASE_URL || "").replace(/[/]+$/, "");
    if (!apiBase) {
      setData(null);
      setError("FlowPay API address is not configured.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await fetch(apiBase + "/customer/account-details", {
        method: "GET",
        credentials: "omit",
        headers: { Authorization: "Bearer " + token }
      });
      const body: unknown = await response.json().catch(() => null);
      const errorBody = asRecord(body);
      if (!response.ok) {
        throw new Error(response.status === 401
          ? "Your session has expired. Please sign in again."
          : typeof errorBody?.error === "string" ? errorBody.error.slice(0, 200) : "Unable to load account details.");
      }
      const parsed = parseAccountDetails(body);
      if (!parsed) throw new Error("The account service returned incomplete or invalid account details.");
      setData(parsed);
    } catch (cause) {
      setData(null);
      setError(cause instanceof Error ? cause.message : "Unable to load account details.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let active = true;
    const apiBase = String(import.meta.env.VITE_API_BASE_URL || "").replace(/[/]+$/, "");
    if (!token || !apiBase) {
      setPaystackDva(null);
      setPaystackDvaError("The Paystack receiving-account service is not configured.");
      setPaystackDvaLoading(false);
      return () => { active = false; };
    }
    setPaystackDvaLoading(true);
    setPaystackDvaError("");
    fetch(apiBase + "/customer/dedicated-bank-account", {
      method: "GET",
      credentials: "omit",
      headers: { Authorization: "Bearer " + token }
    }).then(async response => {
      const body = asRecord(await response.json().catch(() => null));
      if (!response.ok) throw new Error(typeof body?.message === "string"
        ? body.message
        : typeof body?.error === "string" ? body.error : "Paystack account status is unavailable.");
      const account = asRecord(body?.virtualBankAccount);
      if ((body?.environment !== "test" && body?.environment !== "live") ||
          typeof body?.assignmentEnabled !== "boolean" || !account ||
          typeof account.assigned !== "boolean" || typeof account.status !== "string") {
        throw new Error("Paystack returned incomplete receiving-account status.");
      }
      const accountNumber = typeof account.accountNumber === "string" && /^\d{10}$/.test(account.accountNumber)
        ? account.accountNumber : null;
      const bankName = typeof account.bankName === "string" ? account.bankName : null;
      const accountName = typeof account.accountName === "string" ? account.accountName : null;
      if (account.assigned && (!accountNumber || !bankName || !accountName)) {
        throw new Error("Paystack marked this account assigned but did not return complete bank details.");
      }
      return {
        environment: body.environment,
        assignmentEnabled: body.assignmentEnabled,
        livePaymentsEnabled: body.livePaymentsEnabled === true,
        account: {
          assigned: account.assigned,
          status: account.status.slice(0, 40),
          accountNumber,
          bankName,
          accountName
        },
        message: typeof body.message === "string" ? body.message.slice(0, 300) : "Paystack account status loaded."
      } satisfies PaystackDva;
    }).then(value => {
      if (active) setPaystackDva(value);
    }).catch(cause => {
      if (!active) return;
      setPaystackDva(null);
      setPaystackDvaError(cause instanceof Error ? cause.message : "Unable to load Paystack receiving-account status.");
    }).finally(() => {
      if (active) setPaystackDvaLoading(false);
    });
    return () => { active = false; };
  }, [token]);

  return <section className="fp-panel fp-detail-panel fp-account-page">
    <div className="fp-account-hero">
      <span className="fp-account-hero-icon"><Building2 size={22}/></span>
      <span className="fp-money-eyebrow">FLOWPAY · ACCOUNT CENTRE</span>
      <h2>Your FlowPay identity</h2>
      <p>Your permanent 10-digit FlowPay ID and Neon-verified mobile number identify the same wallet inside FlowPay. A separate Paystack bank account number appears here only after Paystack confirms a dedicated virtual account assignment.</p>
      <div className="fp-account-number-highlight">
        <div>
          <small>YOUR PERMANENT FLOWPAY ID</small>
          <strong>{data?.flowpayAccountNumber || (loading ? "Assigning…" : "Not assigned")}</strong>
        </div>
        {data?.flowpayAccountNumber && <button type="button" onClick={() => void copyFlowPayId()} aria-label="Copy FlowPay ID">
          <Copy size={17}/> Copy
        </button>}
      </div>
    </div>

    {loading ? <p className="fp-overview-muted" role="status">Loading your FlowPay identity and wallets…</p>
      : error ? <div className="fp-preview-warning" role="alert">{error}</div>
      : <>
        <div className="fp-account-detail-grid">
          <article className="fp-account-type-card fp-account-wallet-card">
            <span className="fp-account-type-icon"><Wallet size={19}/></span>
            <span className="fp-money-eyebrow">FLOWPAY WALLET</span>
            <h3>Receive from FlowPay</h3>
            <p>Share this permanent 10-digit ID with another FlowPay customer to receive a wallet transfer.</p>
            <div className="fp-account-type-value">{data?.flowpayAccountNumber || "Not yet assigned"}</div>
            <span className="fp-account-live-label">
              <Check size={14}/> {data?.flowpayAccountNumber ? "Permanent ID assigned" : "Awaiting assignment"}
            </span>
            {data?.flowpayAccountNumber && <button type="button" className="fp-outline" onClick={() => void copyFlowPayId()}>
              <Copy size={14}/> Copy FlowPay ID
            </button>}
          </article>
          <article className="fp-account-type-card fp-account-bank-card">
            <span className="fp-account-type-icon"><Smartphone size={19}/></span>
            <span className="fp-money-eyebrow">PHONE-BASED RECEIVING</span>
            <h3>Receive by mobile number</h3>
            <p>Your verified registration phone number is a second way for another FlowPay customer to find the same wallet.</p>
            <div className="fp-account-type-value">{data?.phoneAliasVerified ? data.phoneNumber : "Phone verification required"}</div>
            <span className={data?.phoneAliasVerified ? "fp-account-live-label" : "fp-account-live-label is-pending"}>
              <ShieldCheck size={14}/> {data?.phoneAliasVerified ? "Neon-verified FlowPay phone alias" : "Not yet verified by Neon Auth"}
            </span>
            {data?.phoneAliasVerified && <button type="button" className="fp-outline" onClick={() => void copyPhoneNumber()}>
              <Copy size={14}/> Copy verified phone number
            </button>}
            <small className="fp-muted">This phone number resolves to the same FlowPay wallet inside FlowPay. Appearing in every Nigerian bank's transfer lookup requires NIBSS/partner approval and a supported phone-proxy service; it is not yet active.</small>
          </article>
        </div>

        <section className="fp-account-wallets fp-paystack-receiving-account" aria-label="Paystack receiving bank account">
          <div className="fp-money-section-heading">
            <div><span className="fp-money-eyebrow">PAYSTACK · BANK RECEIVING</span><h3>Your dedicated virtual bank account</h3></div>
            <span className="fp-money-count">{paystackDva?.environment === "live" ? "LIVE" : paystackDva?.environment === "test" ? "TEST" : "STATUS"}</span>
          </div>
          {paystackDvaLoading ? <p className="fp-muted">Checking Paystack account assignment…</p>
            : paystackDvaError ? <div className="fp-preview-warning" role="alert">{paystackDvaError}</div>
            : paystackDva?.account.assigned ? <>
                <div className="fp-account-wallet-list">
                  <div>
                    <span className="fp-account-currency"><Building2 size={18}/></span>
                    <span><b>{paystackDva.account.bankName}</b><small>Bank shown by Paystack</small></span>
                    <strong>Assigned</strong>
                  </div>
                </div>
                <div className="fp-account-number-highlight">
                  <div><small>PAYSTACK NUBAN</small><strong>{paystackDva.account.accountNumber}</strong></div>
                  <button type="button" onClick={() => void copyPaystackAccount()}><Copy size={16}/> Copy</button>
                </div>
                <div className="fp-detail-list">
                  <div><span>Bank account name</span><b>{paystackDva.account.accountName}</b></div>
                  <div><span>Receiving provider</span><b>Paystack</b></div>
                </div>
                <p className="fp-muted">Use this Paystack-issued NUBAN as the destination account number in a Nigerian bank transfer. The bank account name is shown exactly as Paystack supplied it; FlowPay does not rename or fabricate bank-side details.</p>
              </> : <>
                <div className="fp-preview-warning">
                  <ShieldCheck size={17}/>
                  {paystackDva?.assignmentEnabled
                    ? "Paystack account assignment is enabled for this environment, but no dedicated account has been assigned to this customer yet."
                    : "Paystack has not enabled dedicated-account assignment for this environment. Your bank receiving account number will appear only after Paystack approves and confirms assignment."}
                </div>
                <p className="fp-muted">Your FlowPay ID and verified phone number remain FlowPay wallet identifiers. They are not bank account numbers.</p>
              </>}
          {paystackDva && <p className="fp-muted">{paystackDva.message}</p>}
        </section>

        <div className="fp-account-wallets">
          <div className="fp-money-section-heading">
            <div><span className="fp-money-eyebrow">LEDGER ACCOUNTS</span><h3>Your FlowPay wallets</h3></div>
            <span className="fp-money-count">{data?.walletAccounts.length ?? 0} currencies</span>
          </div>
          {data?.walletAccounts.length
            ? <div className="fp-account-wallet-list">
                {data.walletAccounts.map((wallet,index)=><div key={wallet.currency+"-"+index}>
                  <span className="fp-account-currency">{wallet.currency.slice(0,2)}</span>
                  <span><b>{wallet.currency} wallet</b><small>Created {dateLabel(wallet.createdAt)}</small></span>
                  <strong>{wallet.status === "active" ? "Active" : wallet.status}</strong>
                </div>)}
              </div>
            : <div className="fp-empty"><Wallet size={22}/><b>No wallet account is linked</b><span>Contact FlowPay support if you believe this is incorrect.</span></div>}
        </div>
        {copied && <p className="fp-muted" role="status"><Check size={14}/> {copied}</p>}
        <div className="fp-preview-warning"><ShieldCheck size={17}/>{data?.message}</div>
      </>}

    <div className="fp-account-actions">
      <button className="fp-outline" type="button" onClick={() => void load()} disabled={loading}>
        <RefreshCw size={16}/> Refresh account details
      </button>
      {go && <button className="fp-outline" type="button" onClick={() => go("/documents")}><FileText size={16}/> Documents</button>}
    </div>
  </section>;
}
