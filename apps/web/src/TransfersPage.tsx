import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import {
  ArrowLeftRight, Building2, CheckCircle2, Clock3, RefreshCw, Search,
  ShieldCheck, Wallet
} from "lucide-react";

type Mode = "flowpay" | "bank";
type WalletAccount = { currency: string; status: string; createdAt: string };
type TransferRecord = { id: string; type: string; status: string; createdAt: string; destinationAccountMasked: string };
type Bank = { code: string; name: string };
type LookupState = "idle" | "loading" | "verified" | "failed";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function isWalletAccount(value: unknown): value is WalletAccount {
  const item = asRecord(value);
  return typeof item.currency === "string" && /^[A-Z]{3}$/.test(item.currency)
    && typeof item.status === "string" && typeof item.createdAt === "string"
    && Number.isFinite(Date.parse(item.createdAt));
}
function isTransferRecord(value: unknown): value is TransferRecord {
  const item = asRecord(value);
  return typeof item.id === "string" && !!item.id && typeof item.type === "string"
    && typeof item.status === "string" && typeof item.createdAt === "string"
    && Number.isFinite(Date.parse(item.createdAt))
    && typeof item.destinationAccountMasked === "string";
}
function amountToMinor(value: string): string | null {
  const match = /^(0|[1-9]\d{0,11})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const minor = BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  return minor > 0n && minor <= BigInt(Number.MAX_SAFE_INTEGER) ? minor.toString() : null;
}
function formatAmount(minor: string, currency = "NGN") {
  const amount = Number(minor) / 100;
  try { return new Intl.NumberFormat("en-NG", { style: "currency", currency }).format(amount); }
  catch { return currency + " " + amount.toFixed(2); }
}
function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleString();
}
function apiAddress() {
  return String(import.meta.env.VITE_API_BASE_URL || "").replace(/\/+$/, "");
}

export default function TransfersPage({ token, initialMode = "flowpay" }: { token: string; initialMode?: Mode }) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [wallets, setWallets] = useState<WalletAccount[]>([]);
  const [history, setHistory] = useState<TransferRecord[]>([]);
  const [flowpayAccountNumber, setFlowpayAccountNumber] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState("");

  const [recipientNumber, setRecipientNumber] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [recipientCanTransfer, setRecipientCanTransfer] = useState(false);
  const [recipientLookup, setRecipientLookup] = useState<LookupState>("idle");

  const [banks, setBanks] = useState<Bank[]>([]);
  const [banksLoading, setBanksLoading] = useState(true);
  const [banksError, setBanksError] = useState("");
  const [bankSearch, setBankSearch] = useState("");
  const [bankCode, setBankCode] = useState("");
  const [bankAccountNumber, setBankAccountNumber] = useState("");
  const [bankAccountName, setBankAccountName] = useState("");
  const [bankLookup, setBankLookup] = useState<LookupState>("idle");

  const [amount, setAmount] = useState("");
  const [transactionPin, setTransactionPin] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");
  const [pinSet, setPinSet] = useState(false);
  const [pinStatusLoading, setPinStatusLoading] = useState(true);
  const [pinSetupBusy, setPinSetupBusy] = useState(false);
  const [transferBusy, setTransferBusy] = useState(false);
  const [transferError, setTransferError] = useState("");
  const [transferResult, setTransferResult] = useState<{ reference: string; amountMinor: string; recipientName: string } | null>(null);
  const [bankPreview, setBankPreview] = useState<{ bankName: string; accountName: string; accountNumber: string; amountMinor: string } | null>(null);
  const [bankTransferBusy, setBankTransferBusy] = useState(false);
  const [bankTransferResult, setBankTransferResult] = useState<{
    reference: string; status: string; final: boolean; amountMinor: string;
    bankName: string; accountName: string; accountNumberMasked: string; message: string;
  } | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  useEffect(() => { setMode(initialMode); }, [initialMode]);

  const load = useCallback(async () => {
    if (!token || token.split(".").length !== 3) {
      setPageError("Your secure session is not ready. Sign in again and retry.");
      setLoading(false);
      return;
    }
    const apiBase = apiAddress();
    if (!apiBase) {
      setPageError("FlowPay API address is not configured.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setPageError("");
    try {
      const headers = { Authorization: "Bearer " + token };
      const [accountResponse, historyResponse, pinResponse] = await Promise.all([
        fetch(apiBase + "/customer/account-details", { method: "GET", credentials: "omit", headers }),
        fetch(apiBase + "/customer/money-sent", { method: "GET", credentials: "omit", headers }),
        fetch(apiBase + "/customer/transaction-pin/status", { method: "GET", credentials: "omit", headers })
      ]);
      const [accountBody, historyBody, pinBody] = await Promise.all([
        accountResponse.json().catch(() => ({})),
        historyResponse.json().catch(() => ({})),
        pinResponse.json().catch(() => ({}))
      ]);
      if (!accountResponse.ok) throw new Error(typeof accountBody.error === "string" ? accountBody.error : "Unable to load your wallet account.");
      if (!historyResponse.ok) throw new Error(typeof historyBody.error === "string" ? historyBody.error : "Unable to load your transfer history.");
      if (!pinResponse.ok) throw new Error(typeof pinBody.error === "string" ? pinBody.error : "Unable to check transaction security.");
      const accountList = Array.isArray(accountBody.walletAccounts) ? accountBody.walletAccounts.filter(isWalletAccount) : [];
      const transferList = Array.isArray(historyBody.transfers) ? historyBody.transfers.filter(isTransferRecord) : [];
      setWallets(accountList);
      setHistory(transferList);
      setFlowpayAccountNumber(typeof accountBody.flowpayAccountNumber === "string" ? accountBody.flowpayAccountNumber : null);
      setPinSet(pinBody.transactionPinSet === true);
      if ((Array.isArray(accountBody.walletAccounts) && accountList.length !== accountBody.walletAccounts.length)
        || (Array.isArray(historyBody.transfers) && transferList.length !== historyBody.transfers.length)) {
        setPageError("Some transfer details were incomplete and could not be displayed.");
      }
    } catch (cause) {
      setPageError(cause instanceof Error ? cause.message : "Unable to load transfer information.");
    } finally {
      setLoading(false);
      setPinStatusLoading(false);
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!token || !apiAddress()) { setBanksLoading(false); return; }
    const controller = new AbortController();
    setBanksLoading(true);
    setBanksError("");
    fetch(apiAddress() + "/customer/banks", {
      method: "GET", credentials: "omit", signal: controller.signal,
      headers: { Authorization: "Bearer " + token }
    }).then(async response => {
      const body = asRecord(await response.json().catch(() => ({})));
      if (!response.ok || !Array.isArray(body.banks)) {
        const key = typeof body.error === "string" ? body.error : "BANK_LIST_UNAVAILABLE";
        throw new Error(key);
      }
      const items = body.banks.filter((item: unknown): item is Bank => {
        const bank = asRecord(item);
        return typeof bank.code === "string" && !!bank.code && typeof bank.name === "string" && !!bank.name;
      });
      if (!items.length) throw new Error("BANK_LIST_EMPTY");
      setBanks(items);
    }).catch(cause => {
      if (!controller.signal.aborted) {
        setBanks([]);
        setBanksError(cause instanceof Error ? cause.message : "BANK_LIST_UNAVAILABLE");
      }
    }).finally(() => { if (!controller.signal.aborted) setBanksLoading(false); });
    return () => controller.abort();
  }, [token]);

  useEffect(() => {
    if (mode !== "flowpay") { setRecipientLookup("idle"); return; }
    setRecipientName("");
    setRecipientCanTransfer(false);
    setTransferResult(null);
    if (!/^[1-9]\d{9}$/.test(recipientNumber)) { setRecipientLookup("idle"); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setRecipientLookup("loading");
      try {
        const response = await fetch(apiAddress() + "/customer/flowpay/recipients/lookup", {
          method: "POST", credentials: "omit", signal: controller.signal,
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
          body: JSON.stringify({ accountNumber: recipientNumber })
        });
        const body = asRecord(await response.json().catch(() => ({})));
        if (!response.ok || body.verified !== true || body.accountNumber !== recipientNumber || typeof body.recipientName !== "string") {
          throw new Error(typeof body.error === "string" ? body.error : "FLOWPAY_RECIPIENT_NOT_FOUND");
        }
        setRecipientName(body.recipientName);
        setRecipientCanTransfer(body.canTransfer === true);
        setRecipientLookup("verified");
      } catch {
        if (!controller.signal.aborted) { setRecipientName(""); setRecipientCanTransfer(false); setRecipientLookup("failed"); }
      }
    }, 400);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [mode, recipientNumber, token]);

  useEffect(() => {
    if (mode !== "bank") { setBankLookup("idle"); return; }
    setBankAccountName("");
    setBankPreview(null);
    if (!/^\d{10}$/.test(bankAccountNumber) || !bankCode) { setBankLookup("idle"); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setBankLookup("loading");
      try {
        const response = await fetch(apiAddress() + "/customer/bank-account-lookup", {
          method: "POST", credentials: "omit", signal: controller.signal,
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
          body: JSON.stringify({ accountNumber: bankAccountNumber, bankCode })
        });
        const body = asRecord(await response.json().catch(() => ({})));
        if (!response.ok || body.verified !== true || body.accountNumber !== bankAccountNumber ||
            body.bankCode !== bankCode || typeof body.accountName !== "string") {
          throw new Error(typeof body.error === "string" ? body.error : "ACCOUNT_NAME_NOT_VERIFIED");
        }
        setBankAccountName(body.accountName);
        setBankLookup("verified");
      } catch {
        if (!controller.signal.aborted) { setBankAccountName(""); setBankLookup("failed"); }
      }
    }, 400);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [mode, bankAccountNumber, bankCode, token]);

  const filteredBanks = useMemo(() => {
    const term = bankSearch.trim().toLowerCase();
    return term ? banks.filter(bank => bank.name.toLowerCase().includes(term) || bank.code.toLowerCase().includes(term)) : banks;
  }, [banks, bankSearch]);

  const activeNgnWallet = wallets.some(wallet => wallet.currency === "NGN" && wallet.status.toLowerCase() === "active");

  const setupPin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pinSetupBusy) return;
    if (!/^\d{6}$/.test(transactionPin) || transactionPin !== pinConfirm) {
      setTransferError("Create and confirm a matching 6-digit transaction PIN.");
      return;
    }
    setPinSetupBusy(true);
    setTransferError("");
    try {
      const response = await fetch(apiAddress() + "/customer/transaction-pin/setup", {
        method: "POST", credentials: "omit",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ pin: transactionPin, confirmPin: pinConfirm })
      });
      const body = asRecord(await response.json().catch(() => ({})));
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "TRANSACTION_PIN_SETUP_UNAVAILABLE");
      setPinSet(true);
      setTransactionPin("");
      setPinConfirm("");
    } catch (cause) {
      setTransferError(cause instanceof Error ? cause.message : "Unable to set your transaction PIN.");
    } finally { setPinSetupBusy(false); }
  };

  const submitFlowPayTransfer = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (transferBusy) return;
    const amountMinor = amountToMinor(amount);
    if (!amountMinor) { setTransferError("Enter a valid NGN amount greater than zero."); return; }
    if (recipientLookup !== "verified" || !recipientCanTransfer || !recipientName) {
      setTransferError("Verify an eligible FlowPay recipient before continuing.");
      return;
    }
    if (!activeNgnWallet) { setTransferError("An active NGN FlowPay wallet is required."); return; }
    if (!/^\d{6}$/.test(transactionPin)) { setTransferError("Enter your 6-digit transaction PIN."); return; }

    setTransferBusy(true);
    setTransferError("");
    setTransferResult(null);
    try {
      const response = await fetch(apiAddress() + "/customer/transfers/flowpay", {
        method: "POST", credentials: "omit",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({
          recipientAccountNumber: recipientNumber,
          amountMinor,
          currency: "NGN",
          idempotencyKey,
          transactionPin
        })
      });
      const body = asRecord(await response.json().catch(() => ({})));
      if (!response.ok || body.status !== "posted" || typeof body.reference !== "string") {
        throw new Error(typeof body.error === "string" ? body.error : "FLOWPAY_TRANSFER_NOT_POSTED");
      }
      setTransferResult({
        reference: body.reference,
        amountMinor,
        recipientName
      });
      setAmount("");
      setTransactionPin("");
      setIdempotencyKey(crypto.randomUUID());
      await load();
    } catch (cause) {
      setTransferError(cause instanceof Error ? cause.message : "FlowPay transfer could not be completed.");
    } finally { setTransferBusy(false); }
  };

  const reviewBankTransfer = () => {
    const amountMinor = amountToMinor(amount);
    const bankName = banks.find(bank => bank.code === bankCode)?.name ?? "";
    if (!activeNgnWallet) { setTransferError("An active NGN FlowPay wallet is required."); return; }
    if (bankLookup !== "verified" || !bankAccountName || !bankName) {
      setTransferError("Verify the recipient with the selected bank before reviewing.");
      return;
    }
    if (!amountMinor) { setTransferError("Enter a valid NGN amount greater than zero."); return; }
    setTransferError("");
    setBankTransferResult(null);
    setBankPreview({ bankName, accountName: bankAccountName, accountNumber: bankAccountNumber, amountMinor });
  };

  const submitBankTransfer = async () => {
    if (bankTransferBusy || !bankPreview) return;
    if (!pinSet) { setTransferError("Set your 6-digit transaction PIN before sending to a bank."); return; }
    if (!/^\d{6}$/.test(transactionPin)) { setTransferError("Enter your 6-digit transaction PIN."); return; }
    if (bankLookup !== "verified" || bankPreview.accountNumber !== bankAccountNumber) {
      setTransferError("Re-verify the beneficiary bank account before sending."); return;
    }
    setBankTransferBusy(true);
    setTransferError("");
    try {
      const response = await fetch(apiAddress() + "/customer/transfers/bank", {
        method: "POST", credentials: "omit",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({
          accountNumber: bankPreview.accountNumber,
          bankCode,
          amountMinor: bankPreview.amountMinor,
          idempotencyKey,
          transactionPin
        })
      });
      const body = asRecord(await response.json().catch(() => ({})));
      if (!response.ok || typeof body.reference !== "string" || typeof body.status !== "string") {
        throw new Error(typeof body.error === "string" ? body.error : "BANK_TRANSFER_NOT_SUBMITTED");
      }
      const final = body.final === true || ["success", "failed", "reversed", "blocked", "abandoned", "rejected"].includes(body.status);
      setBankTransferResult({
        reference: body.reference,
        status: body.status,
        final,
        amountMinor: typeof body.amountMinor === "string" ? body.amountMinor : bankPreview.amountMinor,
        bankName: typeof body.bankName === "string" ? body.bankName : bankPreview.bankName,
        accountName: typeof body.accountName === "string" ? body.accountName : bankPreview.accountName,
        accountNumberMasked: typeof body.accountNumberMasked === "string" ? body.accountNumberMasked : "******" + bankPreview.accountNumber.slice(-4),
        message: typeof body.message === "string" ? body.message : "Paystack returned a bank-transfer status."
      });
      setTransactionPin("");
      if (final) {
        setAmount("");
        setIdempotencyKey(crypto.randomUUID());
      }
      await load();
    } catch (cause) {
      setTransferError(cause instanceof Error ? cause.message : "Bank transfer could not be submitted.");
    } finally { setBankTransferBusy(false); }
  };

  const refreshBankTransfer = async () => {
    if (!bankTransferResult || bankTransferBusy) return;
    setBankTransferBusy(true);
    setTransferError("");
    try {
      const response = await fetch(apiAddress() + "/customer/transfers/bank/status?reference=" + encodeURIComponent(bankTransferResult.reference), {
        method: "GET", credentials: "omit", headers: { Authorization: "Bearer " + token }
      });
      const body = asRecord(await response.json().catch(() => ({})));
      if (!response.ok || typeof body.status !== "string") {
        throw new Error(typeof body.error === "string" ? body.error : "BANK_TRANSFER_STATUS_UNAVAILABLE");
      }
      const final = body.final === true || ["success", "failed", "reversed", "blocked", "abandoned", "rejected"].includes(body.status);
      setBankTransferResult(previous => previous ? {
        ...previous,
        status: body.status as string,
        final,
        message: typeof body.message === "string" ? body.message : final
          ? "Paystack reported a final transfer status."
          : "The transfer is still being processed. The amount remains reserved."
      } : previous);
      if (final) setIdempotencyKey(crypto.randomUUID());
      await load();
    } catch (cause) {
      setTransferError(cause instanceof Error ? cause.message : "Unable to refresh bank-transfer status.");
    } finally { setBankTransferBusy(false); }
  };

  const startAnotherBankTransfer = () => {
    setBankTransferResult(null);
    setBankPreview(null);
    setTransactionPin("");
    setAmount("");
    setIdempotencyKey(crypto.randomUUID());
    setTransferError("");
  };

  const changeMode = (next: Mode) => {
    setMode(next);
    setAmount("");
    setTransferError("");
    setTransferResult(null);
    setBankPreview(null);
    setBankTransferResult(null);
    setTransactionPin("");
    setIdempotencyKey(crypto.randomUUID());
  };

  return <section className="fp-panel fp-detail-panel fp-transfer-page">
    <div className="fp-transfer-hero" style={{background:"linear-gradient(135deg,#111827 0%,#252a34 100%)",color:"#fff",borderRadius:20,padding:20,marginBottom:20,boxShadow:"0 16px 36px rgba(15,23,42,.16)"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <span style={{width:42,height:42,borderRadius:14,display:"grid",placeItems:"center",background:"rgba(249,115,22,.18)",color:"#fb923c"}}><ArrowLeftRight size={21}/></span>
          <div><div style={{fontSize:11,letterSpacing:1.5,fontWeight:800,color:"#fdba74"}}>FLOWPAY TRANSFERS</div><h2 style={{fontSize:23,lineHeight:1.15,margin:"4px 0 0",color:"#fff"}}>{mode === "flowpay" ? "Send to FlowPay" : "Send to a bank"}</h2></div>
        </div>
        <span style={{fontSize:11,fontWeight:800,letterSpacing:.6,padding:"7px 11px",borderRadius:999,border:"1px solid rgba(255,255,255,.18)",background:"rgba(255,255,255,.08)",color:"#f8fafc"}}>NGN WALLET</span>
      </div>
      <p style={{color:"#cbd5e1",fontSize:13,lineHeight:1.55,margin:"13px 0 17px"}}>{mode === "flowpay" ? "Move money between verified FlowPay wallets, with recipient confirmation and your transaction PIN." : "Send NGN to a verified Nigerian bank account using the Paystack test-transfer flow."}</p>
      <div className="fp-transfer-mode-switch fp-transfer-destination-grid" role="tablist" aria-label="Transfer destination" style={{display:"grid",gridTemplateColumns:"repeat(2,minmax(0,1fr))",gap:10}}>
        <button type="button" role="tab" aria-selected={mode === "flowpay"} onClick={() => changeMode("flowpay")}
          style={{display:"flex",alignItems:"center",gap:11,textAlign:"left",padding:"13px 14px",borderRadius:14,border:mode === "flowpay" ? "2px solid #fb923c" : "1px solid rgba(255,255,255,.18)",background:mode === "flowpay" ? "#f97316" : "rgba(255,255,255,.07)",color:"#fff",cursor:"pointer",minHeight:72}}>
          <Wallet size={22}/><span style={{display:"grid",gap:3}}><b style={{fontSize:14}}>To FlowPay</b><small style={{fontSize:11,color:mode === "flowpay" ? "#fff7ed" : "#cbd5e1"}}>Another FlowPay wallet</small></span>
        </button>
        <button type="button" role="tab" aria-selected={mode === "bank"} onClick={() => changeMode("bank")}
          style={{display:"flex",alignItems:"center",gap:11,textAlign:"left",padding:"13px 14px",borderRadius:14,border:mode === "bank" ? "2px solid #fb923c" : "1px solid rgba(255,255,255,.18)",background:mode === "bank" ? "#f97316" : "rgba(255,255,255,.07)",color:"#fff",cursor:"pointer",minHeight:72}}>
          <Building2 size={22}/><span style={{display:"grid",gap:3}}><b style={{fontSize:14}}>To Bank</b><small style={{fontSize:11,color:mode === "bank" ? "#fff7ed" : "#cbd5e1"}}>Nigerian bank account</small></span>
        </button>
      </div>
    </div>

    {loading ? <p className="fp-overview-muted" role="status">Loading your wallet and transfer security…</p> : <>
      {pageError && <div className="fp-preview-warning" role="alert">{pageError}</div>}
      <div className="fp-detail-list">
        <div><span>Source wallet</span><b>{activeNgnWallet ? "NGN wallet active" : "NGN wallet unavailable"}</b></div>
        <div><span>Transaction PIN</span><b>{pinStatusLoading ? "Checking…" : pinSet ? "Configured" : "Setup required"}</b></div>
      </div>

      <div className="fp-transfer-form-card" style={{border:"1px solid var(--fp-border, #e5e7eb)",borderRadius:18,padding:18,background:"var(--fp-surface, #fff)",marginTop:16}}>
      {mode === "flowpay" ? <>
        <h3 className="fp-account-section-title"><Wallet size={17}/> To another FlowPay wallet</h3>
        <p className="fp-muted" style={{marginTop:-4}}>Enter the recipient's 10-digit FlowPay account number. We will confirm the customer's name before you continue.</p>
        {flowpayAccountNumber && <p className="fp-muted">Your FlowPay account number: <b>{flowpayAccountNumber}</b></p>}
        <label htmlFor="fp-flowpay-recipient">Recipient FlowPay account number</label>
        <input id="fp-flowpay-recipient" value={recipientNumber}
          onChange={event => { setRecipientNumber(event.target.value.replace(/\D/g, "").slice(0, 10)); setTransferResult(null); setTransferError(""); setAmount(""); setIdempotencyKey(crypto.randomUUID()); }}
          inputMode="numeric" autoComplete="off" placeholder="Enter 10-digit FlowPay account number" maxLength={10}/>
        {recipientLookup === "loading" && <p className="fp-overview-muted" role="status">Verifying FlowPay recipient…</p>}
        {recipientLookup === "verified" && <div className="fp-detail-list" role="status">
          <div><span>Verified recipient name</span><b>{recipientName}</b></div>
          <div><span>Account number</span><b>{recipientNumber}</b></div>
          {!recipientCanTransfer && <div><span>Transfer status</span><b>Cannot transfer to your own account</b></div>}
        </div>}
        {recipientLookup === "failed" && <div className="fp-preview-warning" role="alert">No active verified FlowPay customer was found for that account number.</div>}

        {!pinStatusLoading && !pinSet ? <form onSubmit={setupPin} style={{display:"grid",gap:10,marginTop:16,border:"1px solid var(--fp-border, #d8dce3)",borderRadius:12,padding:14}}>
          <b>Set your transaction PIN</b>
          <p className="fp-muted">A 6-digit PIN is required to authorize FlowPay wallet transfers. It is stored as a salted password hash, not as plain text.</p>
          <label htmlFor="fp-transfer-pin-new">Create 6-digit PIN</label>
          <input id="fp-transfer-pin-new" type="password" inputMode="numeric" autoComplete="new-password" pattern="[0-9]{6}" maxLength={6} value={transactionPin} onChange={event => setTransactionPin(event.target.value.replace(/\D/g, "").slice(0, 6))}/>
          <label htmlFor="fp-transfer-pin-confirm">Confirm transaction PIN</label>
          <input id="fp-transfer-pin-confirm" type="password" inputMode="numeric" autoComplete="new-password" pattern="[0-9]{6}" maxLength={6} value={pinConfirm} onChange={event => setPinConfirm(event.target.value.replace(/\D/g, "").slice(0, 6))}/>
          <button className="fp-primary" type="submit" disabled={pinSetupBusy}>{pinSetupBusy ? "Saving PIN…" : "Save transaction PIN"}</button>
        </form> : <form onSubmit={submitFlowPayTransfer} style={{display:"grid",gap:10,marginTop:16}}>
          <label htmlFor="fp-flowpay-amount">Amount (NGN)</label>
          <input id="fp-flowpay-amount" type="number" inputMode="decimal" min="0.01" step="0.01" placeholder="0.00" value={amount} onChange={event => { setAmount(event.target.value); setTransferError(""); setTransferResult(null); setIdempotencyKey(crypto.randomUUID()); }}/>
          <label htmlFor="fp-flowpay-transaction-pin">Transaction PIN</label>
          <input id="fp-flowpay-transaction-pin" type="password" inputMode="numeric" autoComplete="current-password" pattern="[0-9]{6}" maxLength={6} placeholder="6-digit transaction PIN" value={transactionPin} onChange={event => setTransactionPin(event.target.value.replace(/\D/g, "").slice(0, 6))}/>
          <div className="fp-preview-warning"><ShieldCheck size={17}/> FlowPay verifies the recipient, checks your available posted NGN ledger balance, then records the sender debit and recipient credit together in one database transaction. Transfers cannot overdraw the wallet.</div>
          {transferError && <div className="fp-preview-warning" role="alert">{transferError}</div>}
          <button className="fp-primary" type="submit" disabled={transferBusy || !activeNgnWallet || recipientLookup !== "verified" || !recipientCanTransfer || !pinSet}>
            {transferBusy ? "Posting secure transfer…" : "Confirm FlowPay transfer"}
          </button>
        </form>}
        {transferResult && <div className="fp-preview-warning" role="status" aria-live="polite">
          <b><CheckCircle2 size={17} style={{verticalAlign:"middle"}}/> FlowPay transfer posted successfully</b>
          <div>Recipient: {transferResult.recipientName}</div>
          <div>Amount: {formatAmount(transferResult.amountMinor)}</div>
          <div>Reference: {transferResult.reference}</div>
          <div>Both customer ledger entries were committed together.</div>
        </div>}
      </> : <>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,flexWrap:"wrap",marginBottom:12}}>
          <h3 className="fp-account-section-title" style={{margin:0}}><Building2 size={17}/> To a Nigerian bank</h3>
          <span style={{fontSize:11,fontWeight:800,color:"#c2410c",background:"#fff7ed",border:"1px solid #fed7aa",borderRadius:999,padding:"6px 10px"}}>PAYSTACK · TEST MODE</span>
        </div>
        <p className="fp-muted" style={{marginTop:0}}>Verify the recipient's account name before reviewing the bank transfer.</p>
        {banksLoading ? <p className="fp-overview-muted" role="status">Loading Paystack's bank directory…</p> : banksError ? <div className="fp-preview-warning" role="alert">Bank list unavailable ({banksError}). Check PAYSTACK_ENVIRONMENT=test and the Paystack test secret in Render, then refresh.</div> : <>
          <label htmlFor="fp-transfer-bank-search">Search bank name</label>
          <div style={{position:"relative"}}>
            <Search size={16} style={{position:"absolute",left:12,top:13,opacity:.65}}/>
            <input id="fp-transfer-bank-search" type="search" value={bankSearch} onChange={event => setBankSearch(event.target.value)}
              placeholder="Search all available Nigerian banks" style={{paddingLeft:36}}/>
          </div>
          <small className="fp-muted">{filteredBanks.length} of {banks.length} provider-listed banks shown</small>
          <label htmlFor="fp-transfer-bank">Select beneficiary bank</label>
          <select id="fp-transfer-bank" value={bankCode} onChange={event => { setBankCode(event.target.value); setBankAccountName(""); setBankPreview(null); setTransferError(""); }}>
            <option value="">Choose a bank</option>
            {filteredBanks.map(bank => <option key={bank.code} value={bank.code}>{bank.name}</option>)}
          </select>
          {filteredBanks.length === 0 && <p className="fp-muted">No bank matches that search. Try another spelling.</p>}
          <label htmlFor="fp-transfer-bank-account">10-digit beneficiary account number</label>
          <input id="fp-transfer-bank-account" value={bankAccountNumber}
            onChange={event => { setBankAccountNumber(event.target.value.replace(/\D/g, "").slice(0, 10)); setBankPreview(null); setTransferError(""); }}
            inputMode="numeric" autoComplete="off" placeholder="Enter bank account number" maxLength={10}/>
          {bankLookup === "loading" && <p className="fp-overview-muted" role="status">Verifying the account name with the selected bank…</p>}
          {bankLookup === "verified" && <div className="fp-detail-list" role="status">
            <div><span>Verified account name</span><b>{bankAccountName}</b></div>
            <div><span>Selected bank</span><b>{banks.find(bank => bank.code === bankCode)?.name}</b></div>
          </div>}
          {bankLookup === "failed" && <div className="fp-preview-warning" role="alert">The bank could not verify this account number. Check the account number and selected bank.</div>}
          <label htmlFor="fp-bank-transfer-amount">Amount (NGN)</label>
          <input id="fp-bank-transfer-amount" type="number" inputMode="decimal" min="0.01" step="0.01" placeholder="0.00" value={amount}
            onChange={event => { setAmount(event.target.value); setBankPreview(null); setTransferError(""); }}/>
          {transferError && <div className="fp-preview-warning" role="alert">{transferError}</div>}
          <button className="fp-primary" type="button" onClick={reviewBankTransfer}
            disabled={!activeNgnWallet || bankLookup !== "verified" || !amount.trim() || !!bankTransferResult}>Review bank transfer</button>
          {bankPreview && !bankTransferResult && <div className="fp-preview-warning" role="group" aria-label="Bank transfer confirmation">
            <b><CheckCircle2 size={17} style={{verticalAlign:"middle"}}/> Beneficiary verified · Confirm transfer</b>
            <div>Beneficiary: {bankPreview.accountName}</div>
            <div>Bank: {bankPreview.bankName}</div>
            <div>Account: ••••{bankPreview.accountNumber.slice(-4)}</div>
            <div>Amount: {formatAmount(bankPreview.amountMinor)}</div>
            {!pinStatusLoading && !pinSet ? <>
              <p>Set a transaction PIN before authorizing a bank transfer.</p>
              <label htmlFor="fp-bank-transfer-pin-new">Create 6-digit transaction PIN</label>
              <input id="fp-bank-transfer-pin-new" type="password" inputMode="numeric" autoComplete="new-password" maxLength={6}
                value={transactionPin} onChange={event => setTransactionPin(event.target.value.replace(/\D/g, "").slice(0, 6))}/>
              <label htmlFor="fp-bank-transfer-pin-confirm">Confirm transaction PIN</label>
              <input id="fp-bank-transfer-pin-confirm" type="password" inputMode="numeric" autoComplete="new-password" maxLength={6}
                value={pinConfirm} onChange={event => setPinConfirm(event.target.value.replace(/\D/g, "").slice(0, 6))}/>
              <button className="fp-primary" type="button" disabled={pinSetupBusy || !/^\d{6}$/.test(transactionPin) || transactionPin !== pinConfirm}
                onClick={() => void setupPin({ preventDefault: () => undefined } as FormEvent<HTMLFormElement>)}>
                {pinSetupBusy ? "Saving PIN…" : "Save transaction PIN"}
              </button>
            </> : <>
              <label htmlFor="fp-bank-transfer-pin">Transaction PIN</label>
              <input id="fp-bank-transfer-pin" type="password" inputMode="numeric" autoComplete="current-password" maxLength={6}
                placeholder="Enter your 6-digit PIN" value={transactionPin}
                onChange={event => setTransactionPin(event.target.value.replace(/\D/g, "").slice(0, 6))}/>
              <button className="fp-primary" type="button" onClick={() => void submitBankTransfer()}
                disabled={bankTransferBusy || !pinSet || !/^\d{6}$/.test(transactionPin)}>
                {bankTransferBusy ? "Submitting to Paystack…" : "Confirm bank transfer · Test mode"}
              </button>
            </>}
            <small className="fp-muted">Confirming submits a Paystack test transfer. Test mode is simulated and does not move real money.</small>
          </div>}
          {bankTransferResult && <div className="fp-preview-warning" role="status" aria-live="polite">
            <b><CheckCircle2 size={17} style={{verticalAlign:"middle"}}/> Bank transfer · {bankTransferResult.status.toUpperCase()}</b>
            <div>Beneficiary: {bankTransferResult.accountName}</div>
            <div>Bank: {bankTransferResult.bankName}</div>
            <div>Account: {bankTransferResult.accountNumberMasked}</div>
            <div>Amount: {formatAmount(bankTransferResult.amountMinor)}</div>
            <div>Reference: {bankTransferResult.reference}</div>
            <div>{bankTransferResult.message}</div>
            {!bankTransferResult.final && <button type="button" className="fp-outline" onClick={() => void refreshBankTransfer()} disabled={bankTransferBusy}>
              <RefreshCw size={16}/> {bankTransferBusy ? "Checking…" : "Refresh transfer status"}
            </button>}
            {bankTransferResult.final && <button type="button" className="fp-outline" onClick={startAnotherBankTransfer}>
              Start another bank transfer
            </button>}
          </div>}
        </>}
      </>}

      <div className="fp-preview-warning" style={{marginTop:18}}><ShieldCheck size={17}/> Never share your transaction PIN, login password or one-time code. FlowPay deposits remain separate and this transfer page does not change deposit records.</div>
    </div>
    </>}

    <div className="fp-overview-card-heading" style={{marginTop:24}}><span className="fp-overview-icon"><Clock3 size={19}/></span><span>Transfer history</span></div>
    {loading ? <p className="fp-overview-muted">Loading transfer records…</p> : history.length ? <div className="fp-detail-list">
      {history.map(item => <div key={item.id}>
        <span>{item.type.replace(/[_-]/g, " ")} · {item.destinationAccountMasked}<small>{dateLabel(item.createdAt)}</small></span>
        <b>{item.status}</b>
      </div>)}
    </div> : <div className="fp-empty"><Building2 size={22}/><b>No transfers recorded yet</b><span>Completed and pending FlowPay wallet and Paystack test bank transfers appear here.</span></div>}
    <button className="fp-outline" type="button" onClick={() => void load()} disabled={loading}><RefreshCw size={16}/> Refresh transfer details</button>
  </section>;
}
