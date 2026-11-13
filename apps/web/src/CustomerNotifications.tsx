import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, CheckCheck, CircleCheck, CircleX, Clock3, RefreshCw, X } from "lucide-react";

type NotificationStatus = "success" | "failed" | "reversed";
type CustomerNotification = {
  id: string;
  reference: string;
  transferType: "wallet" | "bank";
  direction: "sent" | "received";
  status: NotificationStatus;
  amountMinor: string;
  currency: "NGN";
  title: string;
  message: string;
  createdAt: string;
  readAt: string | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function parseNotification(value: unknown): CustomerNotification | null {
  const row = asRecord(value);
  if (typeof row.id !== "string" || !row.id ||
      typeof row.reference !== "string" ||
      (row.transferType !== "wallet" && row.transferType !== "bank") ||
      (row.direction !== "sent" && row.direction !== "received") ||
      (row.status !== "success" && row.status !== "failed" && row.status !== "reversed") ||
      typeof row.amountMinor !== "string" || !/^\d+$/.test(row.amountMinor) ||
      row.currency !== "NGN" || typeof row.title !== "string" ||
      typeof row.message !== "string" || typeof row.createdAt !== "string" ||
      !Number.isFinite(Date.parse(row.createdAt)) ||
      (row.readAt !== null && typeof row.readAt !== "string")) return null;
  return {
    id: row.id,
    reference: row.reference,
    transferType: row.transferType,
    direction: row.direction,
    status: row.status,
    amountMinor: row.amountMinor,
    currency: "NGN",
    title: row.title,
    message: row.message,
    createdAt: row.createdAt,
    readAt: row.readAt as string | null
  };
}
function apiBase() {
  return String(import.meta.env.VITE_API_BASE_URL || "").replace(/\/+$/, "");
}
function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleString();
}

export default function CustomerNotifications({ token, go }: { token: string; go: (path: string) => void }) {
  const [items, setItems] = useState<CustomerNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [toast, setToast] = useState<CustomerNotification | null>(null);
  const seenIds = useRef<Set<string>>(new Set());
  const hasLoaded = useRef(false);
  const toastTimer = useRef<number | null>(null);

  const load = useCallback(async () => {
    if (!token || token.split(".").length !== 3 || !apiBase()) {
      setLoading(false);
      setError("Notifications are not available. Sign in again and retry.");
      return;
    }
    try {
      const response = await fetch(apiBase() + "/customer/notifications?limit=30", {
        method: "GET",
        credentials: "omit",
        headers: { Authorization: "Bearer " + token }
      });
      const body = asRecord(await response.json().catch(() => ({})));
      if (!response.ok || !Array.isArray(body.notifications) ||
          !Number.isSafeInteger(body.unreadCount) || Number(body.unreadCount) < 0) {
        throw new Error(typeof body.error === "string" ? body.error : "NOTIFICATIONS_UNAVAILABLE");
      }
      const next = body.notifications.map(parseNotification);
      if (next.some(item => item === null)) throw new Error("INVALID_NOTIFICATION_RESPONSE");
      const parsed = next as CustomerNotification[];
      if (hasLoaded.current) {
        const fresh = parsed.find(item => !seenIds.current.has(item.id) && !item.readAt);
        if (fresh) {
          setToast(fresh);
          if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
          toastTimer.current = window.setTimeout(() => setToast(null), 7_000);
        }
      }
      seenIds.current = new Set(parsed.map(item => item.id));
      hasLoaded.current = true;
      setItems(parsed);
      setUnreadCount(Number(body.unreadCount));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "NOTIFICATIONS_UNAVAILABLE");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => { void load(); }, 15_000);
    return () => {
      window.clearInterval(interval);
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    };
  }, [load]);

  const markRead = async (ids: string[], all = false) => {
    if (!token || (!all && ids.length === 0)) return;
    try {
      const response = await fetch(apiBase() + "/customer/notifications/read", {
        method: "POST",
        credentials: "omit",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify(all ? { all: true } : { ids })
      });
      if (!response.ok) throw new Error("NOTIFICATIONS_UPDATE_UNAVAILABLE");
      setItems(current => current.map(item =>
        (all || ids.includes(item.id)) && !item.readAt
          ? { ...item, readAt: new Date().toISOString() } : item
      ));
      if (all) setUnreadCount(0);
      else setUnreadCount(count => Math.max(0, count - ids.filter(id => items.some(item => item.id === id && !item.readAt)).length));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "NOTIFICATIONS_UPDATE_UNAVAILABLE");
    }
  };

  const openTransfer = async (item: CustomerNotification) => {
    await markRead([item.id]);
    setOpen(false);
    setToast(null);
    go(item.transferType === "wallet" || item.transferType === "bank" ? "/transfers" : "/activity");
  };

  return (
    <>
      <div className="fp-notifications">
        <button
          className="fp-notification-trigger"
          type="button"
          aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"}
          aria-expanded={open}
          onClick={() => { setOpen(value => !value); void load(); }}
        >
          <Bell size={19}/>
          {unreadCount > 0 && <span className="fp-notification-count">{unreadCount > 99 ? "99+" : unreadCount}</span>}
        </button>
        {open && <section className="fp-notification-panel" aria-label="FlowPay notifications">
          <div className="fp-notification-panel-head">
            <div><b>Notifications</b><small>{unreadCount} unread alert{unreadCount === 1 ? "" : "s"}</small></div>
            <div className="fp-notification-head-actions">
              <button type="button" title="Refresh notifications" onClick={() => void load()} disabled={loading}><RefreshCw size={15}/></button>
              <button type="button" title="Close notifications" onClick={() => setOpen(false)}><X size={17}/></button>
            </div>
          </div>
          {unreadCount > 0 && <button className="fp-notification-mark-all" type="button" onClick={() => void markRead([], true)}><CheckCheck size={14}/> Mark all as read</button>}
          {loading ? <div className="fp-notification-empty"><RefreshCw size={18}/> Loading alerts…</div>
            : error ? <div className="fp-notification-error" role="alert">{error}</div>
            : items.length === 0 ? <div className="fp-notification-empty"><Bell size={21}/><b>No notifications yet</b><span>Transfer confirmations and status updates will appear here.</span></div>
            : <div className="fp-notification-list">
              {items.map(item => <button
                className={`fp-notification-item ${item.readAt ? "is-read" : "is-unread"} status-${item.status}`}
                type="button" key={item.id} onClick={() => void openTransfer(item)}
              >
                <span className="fp-notification-status-icon">
                  {item.status === "success" ? <CircleCheck size={18}/> : <CircleX size={18}/>}
                </span>
                <span className="fp-notification-copy">
                  <span className="fp-notification-title">{item.title}</span>
                  <span className="fp-notification-message">{item.message}</span>
                  <span className="fp-notification-meta"><Clock3 size={12}/> {dateLabel(item.createdAt)} · {item.reference}</span>
                </span>
                {!item.readAt && <span className="fp-notification-unread-dot" aria-label="Unread"/>}
              </button>)}
            </div>}
          <button className="fp-notification-footer" type="button" onClick={() => { setOpen(false); go("/transfers"); }}>Open transfer history</button>
        </section>}
      </div>
      {toast && <div className={`fp-notification-toast status-${toast.status}`} role="status" aria-live="polite">
        <span className="fp-notification-toast-icon">{toast.status === "success" ? <CircleCheck size={20}/> : <CircleX size={20}/>}</span>
        <span><b>{toast.title}</b><small>{toast.message}</small></span>
        <button type="button" aria-label="Dismiss notification alert" onClick={() => setToast(null)}><X size={16}/></button>
      </div>}
    </>
  );
}
