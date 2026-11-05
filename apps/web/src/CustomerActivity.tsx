import { useEffect, useState } from "react";
import { Activity, AlertCircle, Download, RefreshCw } from "lucide-react";

type Transaction = {
  id: string;
  type: string;
  description: string;
  status: "posted" | "reversed";
  createdAt: string;
  postedAt: string | null;
  currency: string;
  customerLedgerAmountMinor: string;
  direction: "received" | "sent" | "neutral";
  customerEntryCount: number;
};

type ActivityPage = { transactions: Transaction[]; total: number; hasMore: boolean; offset: number; nextOffset: number; limit: number };

const VALID_STATUSES = new Set<Transaction["status"]>(["posted", "reversed"]);
const PAGE_SIZE = 100;

function parseTransactions(value: unknown): Transaction[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): Transaction[] => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Record<string, unknown>;
    if (typeof raw.id !== "string" || !raw.id.trim()) return [];
    const amount = typeof raw.customerLedgerAmountMinor === "string" || typeof raw.customerLedgerAmountMinor === "number"
      ? String(raw.customerLedgerAmountMinor) : "";
    const entryCount = typeof raw.customerEntryCount === "number" && Number.isInteger(raw.customerEntryCount) && raw.customerEntryCount >= 0
      ? raw.customerEntryCount : 0;
    return [{
      id: raw.id,
      type: typeof raw.type === "string" && raw.type.trim() ? raw.type : "transaction",
      description: typeof raw.description === "string" ? raw.description : "",
      status: typeof raw.status === "string" && VALID_STATUSES.has(raw.status as Transaction["status"]) ? raw.status as Transaction["status"] : "posted",
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
      postedAt: typeof raw.postedAt === "string" ? raw.postedAt : null,
      currency: typeof raw.currency === "string" && /^[A-Z]{3}$/.test(raw.currency) ? raw.currency : "NGN",
      customerLedgerAmountMinor: amount,
      direction: raw.direction === "received" || raw.direction === "sent" ? raw.direction : "neutral",
      customerEntryCount: entryCount
    }];
  });
}

function csvCell(value: string | number): string {
  const safe = String(value).replace(/^[=+@]/, "'$&").replace(/^-/, "'-");
  return '"' + safe.replace(/"/g, '""') + '"';
}

export default function CustomerActivity({ token }: { token: string }) {
  const [items, setItems] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const [exportError, setExportError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const apiBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") || "";
  const invalidRange = Boolean(fromDate && toDate && fromDate > toDate);

  const pageUrl = (offset: number) => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    if (fromDate) params.set("fromDate", fromDate);
    if (toDate) params.set("toDate", toDate);
    return apiBase + "/customer/activity?" + params.toString();
  };

  const requestPage = async (offset: number): Promise<ActivityPage> => {
    const response = await fetch(pageUrl(offset), {
      method: "GET",
      credentials: "omit",
      headers: { Authorization: "Bearer " + token }
    });
    const data: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : "Unable to load transaction activity.";
      throw new Error(message);
    }
    const raw = data && typeof data === "object" ? data as Record<string, unknown> : {};
    const transactions = parseTransactions(raw.transactions);
    const pageTotal = typeof raw.total === "number" && Number.isSafeInteger(raw.total) && raw.total >= 0 ? raw.total : transactions.length;
    return {
      transactions, total: pageTotal,
      hasMore: raw.hasMore === true,
      offset: typeof raw.offset === "number" ? raw.offset : offset,
      nextOffset: typeof raw.nextOffset === "number" ? raw.nextOffset : offset + transactions.length,
      limit: typeof raw.limit === "number" ? raw.limit : PAGE_SIZE
    };
  };

  useEffect(() => {
    let active = true;
    if (!token || !apiBase) {
      setItems([]);
      setTotal(0);
      setHasMore(false);
      setNextOffset(0);
      setError("Your authenticated activity service is not configured.");
      setLoading(false);
      return () => { active = false; };
    }
    if (invalidRange) {
      setItems([]);
      setTotal(0);
      setHasMore(false);
      setNextOffset(0);
      setError("");
      setLoading(false);
      return () => { active = false; };
    }
    setLoading(true);
    setError("");
    setExportError("");
    requestPage(0).then(page => {
      if (active) {
        setItems(page.transactions);
        setTotal(page.total);
        setHasMore(page.hasMore);
        setNextOffset(page.nextOffset);
      }
    }).catch(reason => {
      if (active) {
        setItems([]);
        setTotal(0);
        setHasMore(false);
        setNextOffset(0);
        setError(reason instanceof Error ? reason.message : "Unable to load transaction activity.");
      }
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token, apiBase, refresh, fromDate, toDate]);

  const loadMore = async () => {
    if (loadingMore || loading || !hasMore || error) return;
    setLoadingMore(true);
    setExportError("");
    try {
      const page = await requestPage(nextOffset);
      setItems(current => [...current, ...page.transactions]);
      setTotal(page.total);
      setHasMore(page.hasMore);
      setNextOffset(page.nextOffset);
    } catch (reason) {
      setExportError(reason instanceof Error ? reason.message : "Unable to load more transactions.");
    } finally {
      setLoadingMore(false);
    }
  };

  const formatAmount = (minor: string, currency: string) => {
    const value = Number(minor);
    if (!minor || !Number.isFinite(value)) return "Unavailable";
    try {
      return new Intl.NumberFormat("en-NG", { style: "currency", currency, minimumFractionDigits: 2 }).format(value / 100);
    } catch {
      return "Unavailable";
    }
  };

  const formatDate = (value: string) => {
    if (!value) return "Date unavailable";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleString();
  };

  const downloadCsv = async () => {
    if (invalidRange || exporting || total === 0 || loading) return;
    setExporting(true);
    setExportError("");
    try {
      const all: Transaction[] = [];
      let offset = 0;
      let more = true;
      while (more) {
        const page = await requestPage(offset);
        all.push(...page.transactions);
        more = page.hasMore;
        offset = page.nextOffset;
        if (page.transactions.length === 0 && more) throw new Error("The activity service returned an incomplete page. Please refresh and try again.");
      }
      const rows = [
        ["Transaction ID", "Type", "Direction", "Description", "Status", "Date", "Currency", "Ledger amount minor units", "Customer ledger entries"],
        ...all.map(item => [
          item.id, item.type, item.direction, item.description, item.status, item.postedAt || item.createdAt,
          item.currency, item.customerLedgerAmountMinor, item.customerEntryCount
        ])
      ];
      const csv = rows.map(row => row.map(csvCell).join(",")).join("\r\n");
      const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "flowpay-transactions-" + (fromDate || "all") + "-to-" + (toDate || "all") + ".csv";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (reason) {
      setExportError(reason instanceof Error ? reason.message : "Unable to download the complete transaction statement.");
    } finally {
      setExporting(false);
    }
  };

  return <section className="fp-panel fp-detail-panel">
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}>
      <div><h2>Transaction history</h2><p className="fp-muted">Verified posted and reversed ledger activity linked to your customer account.</p></div>
      <button type="button" className="fp-outline" onClick={() => setRefresh(value => value + 1)} disabled={loading}><RefreshCw size={15}/> Refresh</button>
    </div>
    <div className="fp-activity-filters">
      <label>From date<input type="date" value={fromDate} max={toDate || undefined} onChange={event => setFromDate(event.target.value)}/></label>
      <label>To date<input type="date" value={toDate} min={fromDate || undefined} onChange={event => setToDate(event.target.value)}/></label>
      <button type="button" className="fp-outline" onClick={downloadCsv} disabled={loading || exporting || Boolean(error) || invalidRange || total === 0}><Download size={15}/> {exporting ? "Preparing statement…" : "Download CSV"}</button>
      <button type="button" className="fp-activity-clear" onClick={() => { setFromDate(""); setToDate(""); }}>Clear dates</button>
    </div>
    {invalidRange && <div className="fp-preview-warning"><AlertCircle size={17}/> The start date must be on or before the end date.</div>}
    <div className="fp-preview-warning"><Activity size={17}/> Statements include verified posted and reversed ledger records. Direction follows the signed customer ledger amount: positive is received, negative is sent.</div>
    {loading && <p className="fp-muted">Loading verified activity…</p>}
    {error && <div className="fp-preview-warning"><AlertCircle size={17}/> {error}</div>}
    {exportError && <div className="fp-preview-warning"><AlertCircle size={17}/> {exportError}</div>}
    {!loading && !error && total === 0 && !invalidRange && <div className="fp-empty"><Activity size={24}/><b>No posted transaction history yet</b><span>Only records confirmed by the FlowPay ledger appear here.</span></div>}
    {!loading && !error && items.length > 0 && <div className="fp-activity-result-count">Showing {items.length} of {total} matching transactions</div>}
    {!loading && !error && items.length > 0 && <div className="fp-feature-list">
      {items.map(item => <div key={item.id + ":" + item.currency} style={{alignItems:"flex-start",gap:12}}>
        <Activity size={18}/>
        <div style={{minWidth:0,flex:1,display:"grid",gap:4}}>
          <b>{item.description || item.type.replace(/_/g," ")}</b>
          <small>{item.type.replace(/_/g," ")} · {formatDate(item.postedAt || item.createdAt)}</small>
          <small>{item.direction === "received" ? "Money received" : item.direction === "sent" ? "Money sent" : "Neutral ledger movement"} · {item.customerEntryCount} customer ledger {item.customerEntryCount === 1 ? "entry" : "entries"}</small>
        </div>
        <div style={{textAlign:"right",display:"grid",gap:4}}>
          <b>{formatAmount(item.customerLedgerAmountMinor,item.currency)}</b>
          <small>{item.status}</small>
        </div>
      </div>)}
    </div>}
    {!loading && !error && hasMore && <button type="button" className="fp-outline" onClick={loadMore} disabled={loadingMore}>{loadingMore ? "Loading…" : "Load more transactions"}</button>}
    {!loading && !error && total > 0 && <p className="fp-overview-footnote">Date filters are applied by the API to your full matching ledger history. CSV downloads retrieve every matching page, not just the rows currently displayed.</p>}
  </section>;
}
