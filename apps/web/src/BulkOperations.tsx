import { useMemo, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, FileUp, LockKeyhole, RefreshCw, ShieldCheck, Wallet, XCircle } from "lucide-react";

type Mode = "payments" | "verification";
type Row = { line: number; values: string[]; errors: string[] };
const LIMIT_BYTES = 2 * 1024 * 1024;
const LIMIT_ROWS = 5000;

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
    } else if (ch === "," ) {
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

function validate(mode: Mode, headers: string[], values: string[], seen: Set<string>): string[] {
  const errors: string[] = [];
  const get = (name: string) => values[headers.indexOf(name)]?.trim() ?? "";
  if (mode === "payments") {
    const name = get("recipient_name"), account = get("account_number"), bank = get("bank_code");
    const amountText = get("amount"), amount = Number(amountText), reference = get("reference");
    if (!name) errors.push("Recipient name is required");
    if (!/^\d{10}$/.test(account)) errors.push("Account number must be 10 digits");
    if (!/^\d{3}$/.test(bank)) errors.push("Bank code must be 3 digits");
    if (!/^(?:0|[1-9]\\d*)(?:\\.\\d{1,2})?$/.test(amountText) || !Number.isFinite(amount) || amount <= 0 || amount > 100000000) errors.push("Amount must be between ₦0.01 and ₦100,000,000 with no more than 2 decimal places");
    if (!/^[A-Za-z0-9_-]{4,40}$/.test(reference)) errors.push("Reference must be 4–40 letters, numbers, _ or -");
    const key = reference.toLowerCase();
    if (key && seen.has(key)) errors.push("Duplicate payment reference");
    if (key) seen.add(key);
  } else {
    const name = get("full_name"), email = get("email").toLowerCase(), phone = get("phone");
    if (name.length < 3) errors.push("Full name must contain at least 3 characters");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push("A valid email address is required");
    if (!/^\+?[0-9\s-]{10,16}$/.test(phone)) errors.push("Enter a valid contact phone number");
    if (email && seen.has(email)) errors.push("Duplicate email in this file");
    if (email) seen.add(email);
  }
  return errors;
}

const paymentHeaders = ["recipient_name", "account_number", "bank_code", "amount", "reference"];
const verificationHeaders = ["full_name", "email", "phone"];

export default function BulkOperations({ mode }: { mode: Mode }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [notice, setNotice] = useState("");
  const expected = mode === "payments" ? paymentHeaders : verificationHeaders;
  const validCount = rows.filter(row => row.errors.length === 0).length;
  const invalidCount = rows.length - validCount;
  const totalMinor = useMemo(() => mode === "payments" ? rows.reduce((sum, row) => {
    if (row.errors.length) return sum;
    const [whole, fraction = ""] = row.values[3].split(".");
    return sum + Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  }, 0) : 0, [mode, rows]);

  async function loadFile(file?: File) {
    setError(""); setNotice(""); setReviewed(false); setRows([]); setFileName("");
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".csv")) { setError("Please select a .csv file."); return; }
    if (file.size > LIMIT_BYTES) { setError("File exceeds the 2 MB limit."); return; }
    try {
      const parsed = parseCsv(await file.text());
      if (parsed.length < 2) throw new Error("The CSV must contain a header and at least one data row.");
      if (parsed.length - 1 > LIMIT_ROWS) throw new Error(`Maximum ${LIMIT_ROWS.toLocaleString()} rows per batch.`);
      const headers = parsed[0].map((value, index) => (index === 0 ? value.replace(/^\\uFEFF/, "") : value).trim().toLowerCase());
      if (new Set(headers).size !== headers.length) throw new Error("The CSV contains duplicate column headings.");
      const missing = expected.filter(header => !headers.includes(header));
      if (missing.length) throw new Error(`Missing required columns: ${missing.join(", ")}`);
      const seen = new Set<string>();
      const nextRows = parsed.slice(1).map((values, index) => {
        const errors = values.length !== headers.length ? [`Expected ${headers.length} columns but found ${values.length}`] : [];
        errors.push(...validate(mode, headers, values, seen));
        return { line: index + 2, values: expected.map(header => values[headers.indexOf(header)] ?? ""), errors };
      });
      setRows(nextRows); setFileName(file.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to read this CSV file.");
    }
  }

  function downloadTemplate() {
    const sample = mode === "payments"
      ? "recipient_name,account_number,bank_code,amount,reference\nExample Recipient,0123456789,001,1000.00,FPAY-TEST-0001\n"
      : "full_name,email,phone\nExample Customer,customer@example.com,+2348012345678\n";
    const blob = new Blob([sample], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = url;
    link.download = mode === "payments" ? "flowpay-bulk-payments-template.csv" : "flowpay-bulk-verification-template.csv";
    link.click(); URL.revokeObjectURL(url);
  }

  function reset() {
    setRows([]); setFileName(""); setError(""); setNotice(""); setReviewed(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  const title = mode === "payments" ? "Bulk Payments" : "Bulk Verification";
  return <section className="fp-panel fp-bulk-panel">
    <div className="fp-bulk-intro">
      <div className="fp-bulk-icon">{mode === "payments" ? <Wallet/> : <ShieldCheck/>}</div>
      <div><h2>{title}</h2><p>{mode === "payments" ? "Prepare a batch of bank-transfer instructions and validate every row before approval." : "Prepare a customer contact list and check record completeness before an approved KYC workflow."}</p></div>
    </div>
    <div className="fp-bulk-safety"><LockKeyhole size={17}/><span><b>Protected review mode.</b> Files are processed in this browser only. Nothing is uploaded, no money is moved, and no identity checks are submitted.</span></div>
    <div className="fp-bulk-template"><div><b>1. Download the CSV template</b><small>Use the exact column headings and keep each row to one record.</small></div><button type="button" className="fp-outline" onClick={downloadTemplate}>Download template</button></div>
    <div className="fp-bulk-upload">
      <FileUp size={25}/><b>2. Select your CSV file</b><span>CSV only · Maximum 2 MB and {LIMIT_ROWS.toLocaleString()} records</span>
      <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={event => void loadFile(event.target.files?.[0])}/>
    </div>
    {error && <div className="fp-bulk-error"><AlertCircle size={17}/>{error}</div>}
    {fileName && <div className="fp-bulk-file"><CheckCircle2 size={17}/><span>{fileName}</span><button type="button" onClick={reset} aria-label="Remove file"><XCircle size={17}/></button></div>}
    {rows.length > 0 && <>
      <div className="fp-bulk-stats">
        <div><small>Records</small><b>{rows.length.toLocaleString()}</b></div>
        <div><small>Valid rows</small><b className="is-valid">{validCount.toLocaleString()}</b></div>
        <div><small>Rows with errors</small><b className={invalidCount ? "is-invalid" : ""}>{invalidCount.toLocaleString()}</b></div>
        {mode === "payments" && <div><small>Valid total</small><b>₦{(totalMinor / 100).toLocaleString("en-NG",{minimumFractionDigits:2,maximumFractionDigits:2})}</b></div>}
      </div>
      <div className="fp-bulk-review-head"><div><b>3. Review records</b><small>Showing up to 100 rows. Correct errors in your CSV and re-upload.</small></div><button type="button" className="fp-outline" onClick={reset}><RefreshCw size={15}/> Clear batch</button></div>
      <div className="fp-bulk-table-wrap"><table className="fp-bulk-table"><thead><tr><th>CSV row</th>{expected.map(h=><th key={h}>{h.replaceAll("_"," ")}</th>)}<th>Validation</th></tr></thead>
        <tbody>{rows.slice(0,100).map(row=><tr key={row.line}><td>{row.line}</td>{row.values.map((value,index)=><td key={index}>{expected[index] === "amount" && value ? `₦${Number(value).toLocaleString("en-NG")}` : value || "—"}</td>)}<td>{row.errors.length ? <span className="fp-bulk-row-error" title={row.errors.join("; ")}>{row.errors.join("; ")}</span> : <span className="fp-bulk-row-valid">Valid</span>}</td></tr>)}</tbody>
      </table></div>
      {rows.length > 100 && <p className="fp-muted">Preview limited to first 100 of {rows.length.toLocaleString()} rows; validation covers the full file.</p>}
      <button type="button" className="fp-primary fp-bulk-review-button" disabled={invalidCount > 0 || reviewed} onClick={() => { setReviewed(true); setNotice("Validation review completed locally. No batch was submitted or processed."); }}> {reviewed ? "Review completed" : "Confirm validation review"} </button>
      {notice && <div className="fp-bulk-notice"><CheckCircle2 size={17}/>{notice}</div>}
    </>}
    <div className="fp-bulk-blocked"><AlertCircle size={18}/><div><b>{mode === "payments" ? "Payment execution is not enabled" : "Identity verification is not enabled"}</b><p>{mode === "payments" ? "A live batch requires approved provider integration, verified beneficiaries, maker-checker authorization, ledger posting, idempotency and reconciliation. This page cannot debit or transfer funds." : "This batch checks contact-record completeness only. BVN, NIN, document images and biometric data are intentionally not collected here. Actual checks require an approved KYC provider, consent and secure backend processing."}</p></div></div>
  </section>;
}
