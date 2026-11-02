import { useMemo, useState, type CSSProperties } from "react";
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, LockKeyhole, ShieldCheck, UploadCloud } from "lucide-react";

type Mode = "payments" | "verification";
type BeneficiaryRow = {
  beneficiaryName: string;
  accountNumber: string;
  bankCode: string;
  amount?: string;
  currency?: string;
  reference?: string;
};
type ParsedRow = BeneficiaryRow & { line: number; issues: string[] };

const panel: CSSProperties = { background: "#171a20", border: "1px solid #303641", borderRadius: 14, padding: 18 };
const muted: CSSProperties = { color: "#a6afbd", fontSize: 13 };
const field: CSSProperties = { background: "#101319", color: "#f3f5f8", border: "1px solid #39414e", borderRadius: 8, padding: "10px 12px" };

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"' && quoted && text[i + 1] === '"') { cell += '"'; i++; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { row.push(cell.trim()); cell = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(cell.trim()); cell = "";
      if (row.some((value) => value.length)) rows.push(row);
      row = [];
    } else cell += char;
  }
  row.push(cell.trim());
  if (row.some((value) => value.length)) rows.push(row);
  return rows;
}

function validateRows(rows: string[][], mode: Mode): ParsedRow[] {
  if (!rows.length) return [];
  const headers = rows[0].map((value) => value.toLowerCase().replace(/[\s-]+/g, "_"));
  const index = (name: string) => headers.indexOf(name);
  return rows.slice(1).map((cells, i) => {
    const value = (name: string) => { const at = index(name); return at >= 0 ? (cells[at] ?? "").trim() : ""; };
    const item: ParsedRow = {
      line: i + 2,
      beneficiaryName: value("beneficiary_name") || value("name"),
      accountNumber: value("account_number"),
      bankCode: value("bank_code"),
      amount: value("amount"),
      currency: value("currency") || "NGN",
      reference: value("reference"),
      issues: []
    };
    if (!item.beneficiaryName) item.issues.push("Beneficiary name is missing");
    if (!/^\d{10}$/.test(item.accountNumber)) item.issues.push("Account number must contain 10 digits");
    if (!/^\d{3,10}$/.test(item.bankCode)) item.issues.push("Bank code is missing or malformed");
    if (mode === "payments") {
      if (!item.amount || !/^\d+(\.\d{1,2})?$/.test(item.amount) || Number(item.amount) <= 0) item.issues.push("Amount must be a positive number");
      if (item.currency !== "NGN") item.issues.push("Only NGN is currently accepted for this draft template");
    }
    return item;
  });
}

function downloadCsv(mode: Mode) {
  const header = mode === "payments"
    ? "beneficiary_name,account_number,bank_code,amount,currency,reference\n"
    : "beneficiary_name,account_number,bank_code\n";
  const blob = new Blob([header], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = mode === "payments" ? "flowpay-bulk-payments-template.csv" : "flowpay-bulk-verification-template.csv";
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function BulkOperations({ mode }: { mode: Mode }) {
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const isPayments = mode === "payments";
  const validCount = useMemo(() => rows.filter((row) => row.issues.length === 0).length, [rows]);
  const invalidCount = rows.length - validCount;

  async function handleFile(file?: File) {
    if (!file) return;
    setError("");
    setRows([]);
    setFileName(file.name);
    if (!file.name.toLowerCase().endsWith(".csv")) {
      setError("Please upload a CSV file. Download the FlowPay template below; Excel files can be saved as CSV.");
      return;
    }
    setLoading(true);
    try {
      const parsed = validateRows(parseCsv(await file.text()), mode);
      if (!parsed.length) setError("The CSV contains no beneficiary rows. Add rows below the header and try again.");
      else setRows(parsed);
    } catch {
      setError("The CSV could not be read. Check its format and try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section style={{ display: "grid", gap: 16, color: "#f3f5f8" }}>
      <section style={{ ...panel, display: "flex", gap: 12, alignItems: "flex-start" }}>
        <span style={{ color: "#f0a04b" }}>{isPayments ? <LockKeyhole size={23} /> : <ShieldCheck size={23} />}</span>
        <div>
          <strong>{isPayments ? "Bulk payment execution is disabled" : "Local validation only — bank verification is not connected"}</strong>
          <p style={muted}>{isPayments
            ? "You can prepare and review a batch, but FlowPay will not submit transfers, debit an account, or create ledger entries until an approved provider and merchant permissions are configured."
            : "This page checks file structure and field formats only. It does not confirm account ownership, account name, bank status, or whether an account can receive funds."}</p>
        </div>
      </section>

      <section style={panel}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <div><h2 style={{ margin: 0 }}>{isPayments ? "Prepare bulk payments" : "Bulk beneficiary verification"}</h2><p style={muted}>Upload a CSV file using the FlowPay template. Nothing is sent to a bank or payment provider.</p></div>
          <button type="button" onClick={() => downloadCsv(mode)} style={{ ...field, display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer" }}><Download size={16} /> Download CSV template</button>
        </div>
        <label style={{ marginTop: 18, border: "1px dashed #596474", borderRadius: 12, minHeight: 130, display: "grid", placeItems: "center", padding: 20, textAlign: "center", cursor: "pointer", background: "#11151b" }}>
          <UploadCloud size={27} color="#f0a04b" />
          <strong>{loading ? "Reading file…" : "Choose a CSV file"}</strong>
          <span style={muted}>{fileName || "CSV only · Save Excel workbooks as CSV before uploading"}</span>
          <input type="file" accept=".csv,text/csv" disabled={loading} onChange={(event) => void handleFile(event.target.files?.[0])} style={{ display: "none" }} />
        </label>
        {error && <p role="alert" style={{ color: "#ff9b9b" }}>{error}</p>}
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12 }}>
        <div style={panel}><span style={muted}>Rows loaded</span><h2 style={{ margin: "8px 0 0" }}>{rows.length}</h2></div>
        <div style={panel}><span style={muted}>Format checks passed</span><h2 style={{ margin: "8px 0 0", color: "#73d6a1" }}>{validCount}</h2></div>
        <div style={panel}><span style={muted}>Rows needing correction</span><h2 style={{ margin: "8px 0 0", color: invalidCount ? "#ffb36b" : "#f3f5f8" }}>{invalidCount}</h2></div>
      </section>

      {rows.length > 0 && <section style={{ ...panel, overflowX: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <h2 style={{ margin: 0 }}>Batch review</h2>
          <span style={{ ...muted, display: "inline-flex", alignItems: "center", gap: 6 }}><FileSpreadsheet size={16} /> {fileName}</span>
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 14, fontSize: 13, minWidth: 680 }}>
          <thead><tr>{["CSV line", "Beneficiary", "Account", "Bank code", ...(isPayments ? ["Amount", "Currency"] : []), "Local checks"].map((label) => <th key={label} style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #39414e", color: "#a6afbd" }}>{label}</th>)}</tr></thead>
          <tbody>{rows.map((row) => <tr key={row.line}>
            <td style={{ padding: 10, borderBottom: "1px solid #303641" }}>{row.line}</td>
            <td style={{ padding: 10, borderBottom: "1px solid #303641" }}>{row.beneficiaryName || "—"}</td>
            <td style={{ padding: 10, borderBottom: "1px solid #303641" }}>{row.accountNumber || "—"}</td>
            <td style={{ padding: 10, borderBottom: "1px solid #303641" }}>{row.bankCode || "—"}</td>
            {isPayments && <><td style={{ padding: 10, borderBottom: "1px solid #303641" }}>{row.amount || "—"}</td><td style={{ padding: 10, borderBottom: "1px solid #303641" }}>{row.currency || "—"}</td></>}
            <td style={{ padding: 10, borderBottom: "1px solid #303641", color: row.issues.length ? "#ffb36b" : "#73d6a1" }}>
              {row.issues.length ? row.issues.join("; ") : <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><CheckCircle2 size={14} /> Format valid · provider check pending</span>}
            </td>
          </tr>)}</tbody>
        </table>
        <p style={muted}><AlertTriangle size={14} style={{ verticalAlign: "middle" }} /> Passing local checks does not mean a beneficiary has been bank-verified or a payment is approved.</p>
        {isPayments && <button type="button" disabled style={{ ...field, opacity: 0.55, cursor: "not-allowed" }}>Submit bulk payment — disabled pending provider approval</button>}
      </section>}
    </section>
  );
}
