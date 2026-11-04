import { useEffect, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, Wallet } from "lucide-react";
import { authClient } from "./auth-client";

type BalanceAccount = { currency: string; accountStatus: "active" | "frozen"; balanceMinor: string };
type BalanceResponse = { accounts: BalanceAccount[]; source: "posted_ledger"; asOf: string };
type Props = { go: (path: string) => void };

function formatMinor(minor: string, currency: string) {
  let amount: bigint;
  try { amount = BigInt(minor); } catch { return "Unavailable"; }
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const whole = absolute / 100n;
  const fraction = (absolute % 100n).toString().padStart(2, "0");
  const formattedWhole = new Intl.NumberFormat("en-NG", { maximumFractionDigits: 0 }).format(whole);
  const symbol = currency === "NGN" ? "₦" : currency + " ";
  return (negative ? "-" : "") + symbol + formattedWhole + "." + fraction;
}

export default function BalanceCard({ go }: Props) {
  const [accounts, setAccounts] = useState<BalanceAccount[] | null>(null);
  const [message, setMessage] = useState("Loading your verified ledger balance…");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function loadBalance() {
      const apiBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim().replace(/\\/+$/, "");
      if (!apiBase) {
        if (!cancelled) { setMessage("Wallet service is not configured."); setLoading(false); }
        return;
      }
      try {
        const token = await authClient.getJWTToken();
        if (!token) throw new Error("Your secure session token is unavailable. Please sign in again.");
        const response = await fetch(apiBase + "/customer/balance", {
          method: "GET",
          headers: { Authorization: "Bearer " + token, Accept: "application/json" },
          cache: "no-store"
        });
        const data = await response.json() as BalanceResponse | { error?: string };
        if (!response.ok) {
          const code = "error" in data ? data.error : undefined;
          if (response.status === 404) throw new Error("Your FlowPay wallet account has not been linked yet.");
          if (response.status === 403) throw new Error("This login is not linked to an active verified customer account.");
          if (response.status === 401) throw new Error("Your session needs to be refreshed. Please sign in again.");
          if (response.status === 503) throw new Error("Secure wallet balance service is not configured yet.");
          throw new Error(code || "Unable to retrieve your ledger balance.");
        }
        if (!("accounts" in data) || !Array.isArray(data.accounts) || data.accounts.length === 0) {
          throw new Error("No active customer wallet account was found.");
        }
        if (!cancelled) { setAccounts(data.accounts); setMessage(""); }
      } catch (error) {
        if (!cancelled) setMessage(error instanceof Error ? error.message : "Unable to retrieve your ledger balance.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void loadBalance();
    return () => { cancelled = true; };
  }, []);

  return (
    <section className="fp-balance">
      <div className="fp-balance-top"><span>Available balance</span><Wallet size={20}/></div>
      {loading ? <strong className="fp-balance-unavailable" role="status" aria-live="polite">Loading…</strong>
        : accounts ? <div className="fp-balance-values" aria-live="polite">
            {accounts.map((account) => <strong className="fp-balance-amount" key={account.currency}>{formatMinor(account.balanceMinor, account.currency)}</strong>)}
            {accounts.some((account) => account.accountStatus === "frozen") && <small>One or more accounts are frozen. Contact support for assistance.</small>}
          </div>
        : <strong className="fp-balance-unavailable" role="status" aria-live="polite">Not available</strong>}
      {!loading && message && <small role="status">{message}</small>}
      <div className="fp-balance-actions">
        <button onClick={() => go("/transfers")}><ArrowDownLeft size={17}/> Add money</button>
        <button onClick={() => go("/transfers")}><ArrowUpRight size={17}/> Send money</button>
      </div>
    </section>
  );
}
