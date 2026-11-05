import { useState } from "react";
import type { FormEvent } from "react";
import { Bot, Send, ShieldCheck, Sparkles, X } from "lucide-react";

type Message = { role: "user" | "ai"; text: string };

const suggestions = [
  "How do I send money to another FlowPay account?",
  "How do I review a bank recipient?",
  "Where can I find my transfer history?",
  "How can I secure my account?"
];

const assistantStyles = [
  ".fp-balmz-launcher{position:fixed;right:18px;bottom:calc(88px + env(safe-area-inset-bottom));z-index:76;display:flex;align-items:center;gap:9px;border:0;border-radius:999px;padding:11px 16px 11px 12px;background:#171717;color:#fff;font-weight:800;font-size:13px;box-shadow:0 10px 28px rgba(0,0,0,.22);cursor:pointer}",
  ".fp-balmz-launcher-mark{display:grid;place-items:center;width:30px;height:30px;border-radius:50%;background:#ff7a18;color:#fff}",
  ".fp-balmz-overlay{position:fixed;inset:0;z-index:90;background:rgba(12,15,20,.38);backdrop-filter:blur(2px)}",
  ".fp-balmz-panel{position:absolute;right:14px;bottom:calc(88px + env(safe-area-inset-bottom));display:flex;flex-direction:column;width:min(420px,calc(100vw - 28px));height:min(660px,calc(100dvh - 180px));min-height:390px;overflow:hidden;border:1px solid #e5e7eb;border-radius:22px;background:#fff;box-shadow:0 24px 70px rgba(0,0,0,.25)}",
  ".fp-balmz-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 18px;background:#171717;color:#fff}",
  ".fp-balmz-header-mark{display:grid;place-items:center;width:38px;height:38px;flex:0 0 38px;border-radius:13px;background:#ff7a18}",
  ".fp-balmz-header p{margin:0;color:#fdba74;font-size:9px;font-weight:800;letter-spacing:1.4px}",
  ".fp-balmz-header h2{margin:3px 0 0;color:#fff;font-size:17px;line-height:1.2}",
  ".fp-balmz-close{display:grid;place-items:center;width:34px;height:34px;border:1px solid rgba(255,255,255,.18);border-radius:10px;background:rgba(255,255,255,.08);color:#fff}",
  ".fp-balmz-suggestions{padding:12px 13px 10px;border-bottom:1px solid #f0f0ee;background:#fffaf6}",
  ".fp-balmz-suggestions small{display:block;margin-bottom:8px;color:#8a8a85;font-size:9px;font-weight:800;letter-spacing:1px;text-transform:uppercase}",
  ".fp-balmz-suggestions-list{display:flex;gap:7px;overflow-x:auto;padding-bottom:3px}",
  ".fp-balmz-suggestions button{flex:0 0 auto;max-width:235px;border:1px solid #fed7aa;border-radius:999px;padding:8px 10px;background:#fff;color:#9a3412;font-size:10px;text-align:left}",
  ".fp-balmz-messages{display:flex;flex:1;flex-direction:column;gap:11px;overflow-y:auto;padding:15px;background:#fafaf9}",
  ".fp-balmz-row{display:flex}",
  ".fp-balmz-row.user{justify-content:flex-end}",
  ".fp-balmz-bubble{max-width:88%;white-space:pre-wrap;overflow-wrap:anywhere;border-radius:16px;padding:10px 12px;font-size:12px;line-height:1.55}",
  ".fp-balmz-bubble.ai{border-bottom-left-radius:5px;background:#fff;border:1px solid #e9e9e5;color:#343434}",
  ".fp-balmz-bubble.user{border-bottom-right-radius:5px;background:#f97316;color:#fff}",
  ".fp-balmz-composer{padding:12px;border-top:1px solid #eeeeea;background:#fff}",
  ".fp-balmz-composer form{display:flex;gap:8px}",
  ".fp-balmz-composer input{min-width:0;flex:1;border:1px solid #deded8;border-radius:12px;padding:12px;font-size:12px;outline:none}",
  ".fp-balmz-composer input:focus{border-color:#ff7a18;box-shadow:0 0 0 3px rgba(255,122,24,.12)}",
  ".fp-balmz-send{display:grid;place-items:center;width:44px;flex:0 0 44px;border:0;border-radius:12px;background:#ff7a18;color:#fff}",
  ".fp-balmz-send:disabled{opacity:.45;cursor:not-allowed}",
  ".fp-balmz-safety{display:flex;align-items:center;justify-content:center;gap:5px;margin:9px 0 0;color:#8a8a85;font-size:9px}",
  "@media(min-width:800px){.fp-balmz-launcher{bottom:22px}.fp-balmz-panel{bottom:22px}}",
  "@media(max-width:480px){.fp-balmz-panel{right:8px;bottom:calc(84px + env(safe-area-inset-bottom));width:calc(100vw - 16px);height:min(620px,calc(100dvh - 165px));min-height:350px;border-radius:19px}.fp-balmz-launcher{right:12px}}"
].join("\n");

function apiBase() {
  return String(import.meta.env.VITE_API_BASE_URL || "").replace(/\/+$/, "");
}
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export default function BalmzAiAssistant({ token }: { token: string }) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "ai",
      text: "Hello! I’m BALMZ AI, your FlowPay assistant. Ask me how to use your wallet, transfers, cards, account security or other FlowPay services."
    }
  ]);

  async function sendMessage(value = input) {
    const message = value.trim();
    if (!message || busy) return;
    if (!token || token.split(".").length !== 3 || !apiBase()) {
      setMessages(current => [...current, {
        role: "ai",
        text: "Your secure FlowPay session is not ready. Sign in again and try once more."
      }]);
      return;
    }
    setInput("");
    setMessages(current => [...current, { role: "user", text: message }]);
    setBusy(true);
    try {
      const response = await fetch(apiBase() + "/customer-ai/chat", {
        method: "POST",
        credentials: "omit",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token
        },
        body: JSON.stringify({ message })
      });
      const body = asRecord(await response.json().catch(() => ({})));
      if (!response.ok || body.assistant !== "BALMZ AI" || typeof body.reply !== "string") {
        throw new Error(typeof body.message === "string"
          ? body.message
          : typeof body.error === "string"
            ? body.error
            : "BALMZ AI could not respond right now.");
      }
      setMessages(current => [...current, { role: "ai", text: body.reply as string }]);
    } catch (error) {
      setMessages(current => [...current, {
        role: "ai",
        text: error instanceof Error ? error.message : "BALMZ AI is temporarily unavailable. Please try again."
      }]);
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendMessage();
  }

  return <>
    <style>{assistantStyles}</style>
    <button
      type="button"
      className="fp-balmz-launcher"
      onClick={() => setOpen(true)}
      aria-label="Open BALMZ AI assistant"
      aria-haspopup="dialog"
      aria-expanded={open}
    >
      <span className="fp-balmz-launcher-mark"><Sparkles size={17}/></span>
      BALMZ AI
    </button>
    {open && <div className="fp-balmz-overlay" onClick={() => setOpen(false)}>
      <section
        className="fp-balmz-panel"
        role="dialog"
        aria-modal="true"
        aria-label="BALMZ AI FlowPay assistant"
        onClick={event => event.stopPropagation()}
      >
        <header className="fp-balmz-header">
          <div style={{display:"flex",alignItems:"center",gap:11}}>
            <span className="fp-balmz-header-mark"><Bot size={21}/></span>
            <div>
              <p>FLOWPAY CUSTOMER ASSISTANT</p>
              <h2>BALMZ AI</h2>
            </div>
          </div>
          <button type="button" className="fp-balmz-close" onClick={() => setOpen(false)} aria-label="Close BALMZ AI">
            <X size={18}/>
          </button>
        </header>
        <div className="fp-balmz-suggestions">
          <small>Quick questions</small>
          <div className="fp-balmz-suggestions-list">
            {suggestions.map(item => <button key={item} type="button" disabled={busy} onClick={() => void sendMessage(item)}>{item}</button>)}
          </div>
        </div>
        <div className="fp-balmz-messages" aria-live="polite">
          {messages.map((message, index) => <div key={index} className={"fp-balmz-row " + message.role}>
            <div className={"fp-balmz-bubble " + message.role}>{message.text}</div>
          </div>)}
          {busy && <div className="fp-balmz-row"><div className="fp-balmz-bubble ai">BALMZ AI is preparing a reply…</div></div>}
        </div>
        <div className="fp-balmz-composer">
          <form onSubmit={submit}>
            <input
              value={input}
              onChange={event => setInput(event.target.value)}
              disabled={busy}
              maxLength={2000}
              placeholder="Ask BALMZ AI about FlowPay…"
              aria-label="Message BALMZ AI"
            />
            <button className="fp-balmz-send" type="submit" disabled={busy || !input.trim()} aria-label="Send message">
              <Send size={17}/>
            </button>
          </form>
          <p className="fp-balmz-safety"><ShieldCheck size={12}/> Never share your PIN, password or OTP in chat.</p>
        </div>
      </section>
    </div>}
  </>;
}
