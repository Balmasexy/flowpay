import { useMemo, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, FileUp, LockKeyhole, RefreshCw, ShieldCheck, Wallet, XCircle } from "lucide-react";

type Mode = "payments" | "verification";
type Row = {
  line: number;
  values: string[];
  errors: string[];
  status?: "ready" | "processing" | "success" | "failed" | "pending" | "unknown" | "verified" | "mismatch";
  message?: string;
  reference?: string;
};
const PAYMENT_LIMIT = 50;
const VERIFICATION_LIMIT = 8;
const LIMIT_BYTES = 2 * 1024 * 1024;

function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false, closedQuote = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') { cell += '"'; i++; }
        else { quoted = false; closedQuote = true; }
      } else cell += ch;
      continue;
    }
    if (ch === '"') {
      if (cell.length || closedQuote) throw new Error("CSV contains a quote in an invalid position.");
      quoted = true;
    } else if (ch === ",") {
      row.push(cell.trim()); cell = ""; closedQuote = false;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      row.push(cell.trim()); cell = ""; closedQuote = false;
      if (row.some(value => value.length)) rows.push(row);
      row = [];
    } else {
      if (closedQuote && ch.trim()) throw new Error("CSV contains characters after a closing quote.");
      cell += ch;
    }
  }
  if (quoted) throw new Error("CSV contains an unclosed quoted field.");
  row.push(cell.trim());
  if (row.some(value => value.length)) rows.push(row);
  return rows;
}
function amountToMinor(value: string): string | null {
  const match = /^(0|[1-9]\d{0,8})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const amount = BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  return amount > 0n && amount <= BigInt(Number.MAX_SAFE_INTEGER) ? amount.toString() : null;
}
function validAccountNumber(value: string) { return /^\d{10}$/.test(value); }
function validBankCode(value: string) { return /^[A-Za-z0-9_-]{2,12}$/.test(value); }
const paymentHeaders = ["recipient_name", "account_number", "bank_code", "amount", "reference"];
const verificationHeaders = ["account_number", "bank_code", "expected_account_name"];

export default function BulkOperations({ mode, token }: { mode: Mode; token: string }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [transactionPin, setTransactionPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [complete, setComplete] = useState(false);
  const expected = mode === "payments" ? paymentHeaders : verificationHeaders;
  const validCount = rows.filter(row => row.errors.length === 0).length;
  const invalidCount = rows.length - validCount;
  const finishedCount = rows.filter(row => ["success", "failed", "pending", "unknown", "verified", "mismatch"].includes(row.status ?? "")).length;
  const totalMinor = useMemo(() => mode === "payments" ? rows.reduce((sum, row) => {
    if (row.errors.length) return sum;
    return sum + BigInt(amountToMinor(row.values[3]) ?? "0");
  }, 0n) : 0n, [mode, rows]);

  async function loadFile(file?: File) {
    setError(""); setNotice(""); setRows([]); setFileName(""); setComplete(false);
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".csv")) { setError("Please select a .csv file."); return; }
    if (file.size > LIMIT_BYTES) { setError("File exceeds the 2 MB limit."); return; }
    try {
      const parsed = parseCsv((await file.text()).replace(/^\uFEFF/, ""));
      if (parsed.length < 2) throw new Error("The CSV must contain a header and at least one data row.");
      const limit = mode === "payments" ? PAYMENT_LIMIT : VERIFICATION_LIMIT;
      if (parsed.length - 1 > limit) throw new Error(`Maximum ${limit} records per batch.`);
      const headers = parsed[0].map(value => value.trim().toLowerCase());
      if (new Set(headers).size !== headers.length) throw new Error("The CSV contains duplicate column headings.");
      const missing = (mode === "payments" ? paymentHeaders : ["account_number", "bank_code"])
        .filter(header => !headers.includes(header));
      if (missing.length) throw new Error(`Missing required columns: ${missing.join(", ")}`);
      const seen = new Set<string>();
      const nextRows = parsed.slice(1).map((values, index) => {
        const mapped = expected.map(header => values[headers.indexOf(header)] ?? "");
        const errors: string[] = [];
        if (values.length !== headers.length) errors.push(`Expected ${headers.length} columns but found ${values.length}`);
        if (mode === "payments") {
          const [name, account, bank, amount, reference] = mapped;
          if (!name) errors.push("Recipient name is required");
          if (!validAccountNumber(account)) errors.push("Account number must be 10 digits");
          if (!validBankCode(bank)) errors.push("Bank code is invalid");
          if (!amountToMinor(amount)) errors.push("Amount must be between ₦0.01 and ₦100,000,000");
          if (!/^[A-Za-z0-9_-]{4,40}$/.test(reference)) errors.push("Reference must be 4–40 letters, numbers, _ or -");
          if (reference && seen.has(reference.toLowerCase())) errors.push("Duplicate payment reference");
          if (reference) seen.add(reference.toLowerCase());
        } else {
          const [account, bank, expectedName] = mapped;
          if (!validAccountNumber(account)) errors.push("Account number must be 10 digits");
          if (!validBankCode(bank)) errors.push("Bank code is invalid");
          if (expectedName && expectedName.length > 160) errors.push("Expected account name is too long");
          const key = account + ":" + bank;
          if (seen.has(key)) errors.push("Duplicate account in this file");
          seen.add(key);
        }
        return { line: index + 2, values: mapped, errors, status: "ready" as const };
      });
      setRows(nextRows); setFileName(file.name);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to read this CSV file.");
    }
  }

  function downloadTemplate() {
    const sample = mode === "payments"
      ? "recipient_name,account_number,bank_code,amount,reference\n"
      : "account_number,bank_code,expected_account_name\n";
    const blob = new Blob([sample], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = url;
    link.download = mode === "payments" ? "flowpay-bulk-payments-template.csv" : "flowpay-bulk-bank-verification-template.csv";
    link.click(); URL.revokeObjectURL(url);
  }
  function reset() {
    setRows([]); setFileName(""); setError(""); setNotice(""); setTransactionPin(""); setComplete(false);
    if (fileRef.current) fileRef.current.value = "";
  }
  function updateRow(index: number, patch: Partial<Row>) {
    setRows(current => current.map((row, at) => at === index ? { ...row, ...patch } : row));
  }

  async function runBatch() {
    if (!token || token.split(".").length !== 3) { setError("Your secure session is not ready. Sign in again."); return; }
    if (!rows.length || invalidCount || busy || complete) return;
    if (mode === "payments" && !/^\d{6}$/.test(transactionPin)) { setError("Enter your 6-digit transaction PIN."); return; }
    const apiBase = String(import.meta.env.VITE_API_BASE_URL || "").replace(/\/+$/, "");
    if (!apiBase) { setError("FlowPay API is not configured."); return; }
    setError(""); setNotice(""); setBusy(true);
    let succeeded = 0, failed = 0, held = 0;
    try {
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index];
        updateRow(index, { status: "processing", message: "Submitting to provider…" });
        try {
          if (mode === "payments") {
            const [recipientName, accountNumber, bankCode, amount, reference] = row.values;
            const response = await fetch(apiBase + "/customer/transfers/bank", {
              method: "POST", credentials: "omit",
              headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
              body: JSON.stringify({
                accountNumber, bankCode, amountMinor: amountToMinor(amount),
                idempotencyKey: crypto.randomUUID(), transactionPin
              })
            });
            const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
            const status = typeof payload.status === "string" ? payload.status : "failed";
            const message = typeof payload.message === "string" ? payload.message : typeof payload.error === "string" ? payload.error : "Provider did not return a transfer status.";
            const final = payload.final === true;
            updateRow(index, {
              status: status === "success" ? "success" : status === "failed" ? "failed" : status === "unknown" ? "unknown" : "pending",
              reference: typeof payload.reference === "string" ? payload.reference : reference,
              message: recipientName + ": " + message
            });
            if (status === "success" && response.ok) succeeded++;
            else if (status === "failed" || !response.ok && final) failed++;
            else {
              held++;
              setNotice("Batch paused because a transfer is pending or its outcome is unconfirmed. Check transfer status before starting any remaining payments.");
              break;
            }
          } else {
            const [accountNumber, bankCode, expectedName] = row.values;
            const response = await fetch(apiBase + "/customer/bank-account-lookup", {
              method: "POST", credentials: "omit",
              headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
              body: JSON.stringify({ accountNumber, bankCode })
            });
            const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
            const actualName = typeof payload.accountName === "string" ? payload.accountName.trim() : "";
            const matches = response.ok && payload.verified === true && actualName &&
              (!expectedName.trim() || actualName.localeCompare(expectedName.trim(), undefined, { sensitivity: "accent" }) === 0);
            updateRow(index, {
              status: matches ? "verified" : "mismatch",
              message: response.ok
                ? matches ? "Verified account name: " + actualName : "Account check did not match the expected name or provider could not verify it."
                : typeof payload.error === "string" ? payload.error : "Bank account check failed."
            });
            if (matches) succeeded++; else failed++;
            if (response.status === 429) {
              held++;
              setNotice("Provider rate limit reached. The remaining rows were not submitted; wait before continuing.");
              break;
            }
          }
        } catch {
          updateRow(index, { status: "unknown", message: "Request outcome is unknown. Check provider/transaction status before any retry." });
          held++;
          if (mode === "payments") {
            setNotice("Batch paused after an unconfirmed network result. Do not retry this row until its transfer status is checked.");
            break;
          }
        }
      }
      setComplete(true);
      setNotice(current => current || `Batch processing finished: ${succeeded} successful, ${failed} unsuccessful, ${held} pending or unconfirmed.`);
    } finally {
      setBusy(false);
    }
  }

  const title = mode === "payments" ? "Bulk Payments" : "Bulk Bank Verification";
  return <section className="fp-panel fp-bulk-panel">
    <div className="fp-bulk-intro">
      <div className="fp-bulk-icon">{mode === "payments" ? <Wallet/> : <ShieldCheck/>}</div>
      <div><h2>{title}</h2><p>{mode === "payments" ? "Review up to 50 Nigerian bank transfers and submit them one at a time with your transaction PIN." : "Verify up to 8 Nigerian bank account names with Paystack before using them as beneficiaries."}</p></div>
    </div>
    <div className="fp-bulk-safety"><LockKeyhole size={17}/><span><b>Protected provider workflow.</b> Your file stays in this browser. Each payment requires your explicit batch submission and is processed individually; verification sends only account number and bank code.</span></div>
    <div className="fp-bulk-template"><div><b>1. Download the CSV template</b><small>{mode === "payments" ? "The payment file contains beneficiary and amount instructions." : "The verification file contains bank account details and an optional expected account name."}</small></div><button type="button" className="fp-outline" onClick={downloadTemplate}>Download template</button></div>
    <div className="fp-bulk-upload">
      <FileUp size={25}/><b>2. Select your CSV file</b><span>CSV only · Maximum 2 MB · {mode === "payments" ? PAYMENT_LIMIT : VERIFICATION_LIMIT} records</span>
      <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={event => void loadFile(event.target.files?.[0])} disabled={busy}/>
    </div>
    {error && <div className="fp-bulk-error"><AlertCircle size={17}/>{error}</div>}
    {fileName && <div className="fp-bulk-file"><CheckCircle2 size={17}/><span>{fileName}</span><button type="button" onClick={reset} aria-label="Remove file" disabled={busy}><XCircle size={17}/></button></div>}
    {rows.length > 0 && <>
      <div className="fp-bulk-stats">
        <div><small>Records</small><b>{rows.length.toLocaleString()}</b></div>
        <div><small>Valid rows</small><b className="is-valid">{validCount.toLocaleString()}</b></div>
        <div><small>Rows with errors</small><b className={invalidCount ? "is-invalid" : ""}>{invalidCount.toLocaleString()}</b></div>
        <div><small>Processed</small><b>{finishedCount.toLocaleString()}</b></div>
        {mode === "payments" && <div><small>Valid total</small><b>₦{(Number(totalMinor) / 100).toLocaleString("en-NG",{minimumFractionDigits:2,maximumFractionDigits:2})}</b></div>}
      </div>
      <div className="fp-bulk-review-head"><div><b>3. Review each record</b><small>Rows with errors cannot be submitted. Provider status is shown per row.</small></div><button type="button" className="fp-outline" onClick={reset} disabled={busy}><RefreshCw size={15}/> Clear batch</button></div>
      <div className="fp-bulk-table-wrap"><table className="fp-bulk-table"><thead><tr><th>CSV row</th>{expected.map(h=><th key={h}>{h.replaceAll("_"," ")}</th>)}<th>Result</th></tr></thead>
        <tbody>{rows.map(row=><tr key={row.line}><td>{row.line}</td>{row.values.map((value,index)=><td key={index}>{expected[index] === "amount" && value ? `₦${Number(value).toLocaleString("en-NG")}` : value || "—"}</td>)}<td>{row.errors.length ? <span className="fp-bulk-row-error">{row.errors.join("; ")}</span> : <span title={row.message}>{row.status === "success" || row.status === "verified" ? <span className="fp-bulk-row-valid">{row.status}</span> : row.status === "failed" || row.status === "mismatch" || row.status === "unknown" || row.status === "pending" ? <span className="fp-bulk-row-error">{row.status}: {row.message}</span> : row.status === "processing" ? "Processing…" : "Ready"}</span>}{row.reference ? <small>{row.reference}</small> : null}</td></tr>)}</tbody>
      </table></div>
      {mode === "payments" && <label style={{display:"block",marginTop:16}}>Transaction PIN<input aria-label="Transaction PIN" type="password" inputMode="numeric" autoComplete="off" maxLength={6} value={transactionPin} onChange={event=>setTransactionPin(event.target.value.replace(/\D/g,"").slice(0,6))} placeholder="Enter 6-digit PIN" disabled={busy}/></label>}
      <button type="button" className="fp-primary fp-bulk-review-button" disabled={busy || complete || invalidCount > 0 || (mode === "payments" && transactionPin.length !== 6) || !token} onClick={() => void runBatch()}>
        {busy ? "Processing batch…" : complete ? "Batch submitted" : mode === "payments" ? "Authorize and execute payments" : "Run provider bank verification"}
      </button>
      {notice && <div className="fp-bulk-notice"><CheckCircle2 size={17}/>{notice}</div>}
    </>}
    <div className="fp-bulk-blocked"><AlertCircle size={18}/><div>
      <b>{mode === "payments" ? "External bank payments are provider-confirmed" : "This is bank-account verification, not full KYC"}</b>
      <p>{mode === "payments" ? "Each transfer is independently authenticated and reconciled through Paystack. Pending or unknown outcomes pause the batch; check transfer history before retrying. Provider approval, a funded Paystack balance and the separate live-transfer switch are required for production payouts." : "Each lookup verifies the account number and resolved bank-account name. BVN, NIN, identity documents and biometric checks require a separate approved KYC provider and explicit consent."}</p>
    </div></div>
  </section>;
}
