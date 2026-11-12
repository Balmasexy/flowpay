import { useCallback, useEffect, useMemo, useState, type JSX, type ReactNode } from "react";
import LandingPage from "./LandingPage";
import "./storyblok-public.css";

type Blok = Record<string, unknown> & { _uid?: string; _editable?: string; component?: string };
type Story = { id: number; name?: string; slug: string; content: Blok };
type StoryblokResponse = { story?: Story };
type BridgeEvent = { story?: Story };
type Bridge = {
  on: (events: string | string[], callback: (event: BridgeEvent) => void) => void;
  off?: (events: string | string[], callback: (event: BridgeEvent) => void) => void;
};

declare global {
  interface Window {
    StoryblokBridge?: new () => Bridge;
  }
}

const PUBLIC_TOKEN = String(import.meta.env.VITE_STORYBLOK_DELIVERY_API_TOKEN ?? "").trim();
const REGION = String(import.meta.env.VITE_STORYBLOK_REGION ?? "eu").trim().toLowerCase();
const API_BASE = String(import.meta.env.VITE_API_BASE_URL ?? "").trim().replace(/\/$/, "");
const REGION_URLS: Record<string, string> = {
  eu: "https://api.storyblok.com/v2/cdn",
  us: "https://api-us.storyblok.com/v2/cdn",
  ap: "https://api-ap.storyblok.com/v2/cdn",
  ca: "https://api-ca.storyblok.com/v2/cdn",
  cn: "https://app.storyblokchina.cn/v2/cdn",
};

export function storyblokIsConfigured() {
  return Boolean(PUBLIC_TOKEN) && Boolean(REGION_URLS[REGION]);
}

function isPreviewRequest() {
  const params = new URLSearchParams(window.location.search);
  return params.has("_storyblok") || params.has("_storyblok_tk[space_id]");
}

function getPreviewQuery(slug: string) {
  const current = new URLSearchParams(window.location.search);
  const required = ["_storyblok", "_storyblok_tk[space_id]", "_storyblok_tk[timestamp]", "_storyblok_tk[token]"];
  if (required.some(key => !current.has(key))) {
    throw new Error("The Storyblok preview URL is missing its signed validation parameters.");
  }
  const forwarded = new URLSearchParams({ slug });
  for (const key of required) forwarded.set(key, current.get(key) ?? "");
  return forwarded;
}

async function fetchStory(slug: string, preview: boolean, signal: AbortSignal): Promise<Story> {
  let url: string;
  if (preview) {
    if (!API_BASE) throw new Error("VITE_API_BASE_URL is required for secure Storyblok preview requests.");
    url = API_BASE + "/storyblok/preview?" + getPreviewQuery(slug).toString();
  } else {
    const base = REGION_URLS[REGION];
    if (!base || !PUBLIC_TOKEN) throw new Error("Storyblok public content delivery is not configured.");
    const endpoint = slug.split("/").map(encodeURIComponent).join("/");
    const query = new URLSearchParams({ token: PUBLIC_TOKEN, version: "published" });
    url = base + "/stories/" + endpoint + "?" + query.toString();
  }

  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    credentials: "omit",
    cache: "no-store",
    signal,
  });
  if (!response.ok) {
    throw new Error(response.status === 404 ? "This Storyblok page has not been created yet." : "Storyblok content is temporarily unavailable.");
  }
  const payload = await response.json() as StoryblokResponse;
  if (!payload.story?.content) throw new Error("Storyblok returned an empty page.");
  return payload.story;
}

function loadBridge(): Promise<void> {
  if (window.StoryblokBridge) return Promise.resolve();
  const existing = document.querySelector<HTMLScriptElement>("script[data-flowpay-storyblok-bridge]");
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Storyblok preview bridge could not load.")), { once: true });
    });
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://app.storyblok.com/f/storyblok-v2-latest.js";
    script.async = true;
    script.dataset.flowpayStoryblokBridge = "true";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Storyblok preview bridge could not load."));
    document.head.appendChild(script);
  });
}

function editableProps(blok: Blok): Record<string, string> {
  const editable = typeof blok._editable === "string" ? blok._editable : "";
  const match = editable.match(/<!--#storyblok#?([\s\S]*?)-->/);
  if (!match) return {};
  try {
    const metadata = JSON.parse(match[1]) as { id?: string | number; uid?: string };
    if (metadata.id === undefined || !metadata.uid) return {};
    return {
      "data-blok-c": JSON.stringify(metadata),
      "data-blok-uid": String(metadata.id) + "-" + metadata.uid,
    };
  } catch {
    return {};
  }
}

function textValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  return "";
}

function linkValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const link = value as Record<string, unknown>;
  return textValue(link.url) || textValue(link.cached_url);
}

function safeHref(value: string): string {
  if (!value) return "#";
  if (value.startsWith("/") || value.startsWith("#")) return value;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? value : "#";
  } catch {
    return "#";
  }
}

function assetUrl(value: unknown): string {
  if (typeof value === "string") return /^https:\/\//i.test(value) ? value : "";
  if (!value || typeof value !== "object") return "";
  const url = textValue((value as Record<string, unknown>).filename);
  return /^https:\/\//i.test(url) ? url : "";
}

type RichNode = { type?: string; text?: string; content?: RichNode[]; marks?: Array<{ type?: string; attrs?: Record<string, unknown> }>; attrs?: Record<string, unknown> };

function richNode(node: RichNode, key: string | number): ReactNode {
  if (node.type === "text") {
    let result: ReactNode = node.text ?? "";
    for (const mark of node.marks ?? []) {
      if (mark.type === "bold") result = <strong key={String(key) + "-bold"}>{result}</strong>;
      else if (mark.type === "italic") result = <em key={String(key) + "-italic"}>{result}</em>;
      else if (mark.type === "strike") result = <s key={String(key) + "-strike"}>{result}</s>;
      else if (mark.type === "code") result = <code key={String(key) + "-code"}>{result}</code>;
      else if (mark.type === "link") {
        const href = safeHref(textValue(mark.attrs?.href));
        result = <a key={String(key) + "-link"} href={href} target={href.startsWith("http") ? "_blank" : undefined} rel={href.startsWith("http") ? "noreferrer" : undefined}>{result}</a>;
      }
    }
    return result;
  }
  if (node.type === "hard_break") return <br key={key}/>;
  const children = (node.content ?? []).map((child, index) => richNode(child, String(key) + "-" + index));
  switch (node.type) {
    case "paragraph": return <p key={key}>{children}</p>;
    case "heading": {
      const level = Math.min(6, Math.max(2, Number(node.attrs?.level ?? 2)));
      const Tag = ("h" + level) as keyof JSX.IntrinsicElements;
      return <Tag key={key}>{children}</Tag>;
    }
    case "bullet_list": return <ul key={key}>{children}</ul>;
    case "ordered_list": return <ol key={key}>{children}</ol>;
    case "list_item": return <li key={key}>{children}</li>;
    case "blockquote": return <blockquote key={key}>{children}</blockquote>;
    case "code_block": return <pre key={key}><code>{children}</code></pre>;
    case "horizontal_rule": return <hr key={key}/>;
    default: return <span key={key}>{children}</span>;
  }
}

function RichText({ value }: { value: unknown }) {
  if (!value || typeof value !== "object") return null;
  const document = value as RichNode;
  return <div className="fp-sb-richtext">{(document.content ?? []).map((node, index) => richNode(node, index))}</div>;
}

function childrenOf(blok: Blok): Blok[] {
  const values = Array.isArray(blok.body) ? blok.body : Array.isArray(blok.items) ? blok.items : Array.isArray(blok.features) ? blok.features : Array.isArray(blok.services) ? blok.services : [];
  return values.filter((value): value is Blok => Boolean(value) && typeof value === "object");
}

function ActionLink({ label, value }: { label: string; value: unknown }) {
  const href = safeHref(linkValue(value));
  if (!label || href === "#") return null;
  return <a className="fp-sb-button" href={href} target={href.startsWith("http") ? "_blank" : undefined} rel={href.startsWith("http") ? "noreferrer" : undefined}>{label}</a>;
}

function Block({ blok }: { blok: Blok }) {
  const component = textValue(blok.component);
  const title = textValue(blok.title) || textValue(blok.headline) || textValue(blok.heading);
  const copy = textValue(blok.text) || textValue(blok.description) || textValue(blok.subheadline);
  const eyebrow = textValue(blok.eyebrow) || textValue(blok.kicker);
  const children = childrenOf(blok);
  const attrs = editableProps(blok);

  if (component === "page" || component === "home" || component === "business_page") {
    return <main className="fp-sb-page" {...attrs}>{children.map((child, index) => <Block key={child._uid ?? index} blok={child}/>)}</main>;
  }
  if (component === "hero" || component === "teaser") {
    const image = assetUrl(blok.image);
    return <section className="fp-sb-hero" {...attrs}>
      <div className="fp-sb-hero-copy">
        {eyebrow && <span className="fp-sb-eyebrow">{eyebrow}</span>}
        <h1>{title || "Your money. Your move."}</h1>
        {copy && <p>{copy}</p>}
        <div className="fp-sb-actions"><ActionLink label={textValue(blok.primary_label) || textValue(blok.button_label)} value={blok.primary_link ?? blok.button_link}/><ActionLink label={textValue(blok.secondary_label)} value={blok.secondary_link}/></div>
      </div>
      {image && <img className="fp-sb-hero-image" src={image} alt={textValue(blok.image_alt) || title} loading="lazy"/>}
    </section>;
  }
  if (component === "feature_grid" || component === "services_grid" || component === "grid" || component === "cards") {
    return <section className="fp-sb-section" {...attrs}>
      <div className="fp-sb-section-heading">{eyebrow && <span className="fp-sb-eyebrow">{eyebrow}</span>}{title && <h2>{title}</h2>}{copy && <p>{copy}</p>}</div>
      <div className="fp-sb-card-grid">{children.map((child, index) => <Block key={child._uid ?? index} blok={child}/>)}</div>
    </section>;
  }
  if (component === "feature" || component === "feature_item" || component === "service_card" || component === "service") {
    return <article className="fp-sb-card" {...attrs}>
      {textValue(blok.icon) && <span className="fp-sb-card-icon" aria-hidden="true">{textValue(blok.icon).slice(0, 3)}</span>}
      {title && <h3>{title}</h3>}
      {copy && <p>{copy}</p>}
      <ActionLink label={textValue(blok.link_label) || textValue(blok.button_label)} value={blok.link ?? blok.button_link}/>
    </article>;
  }
  if (component === "text_section" || component === "rich_text" || component === "article") {
    return <section className="fp-sb-section fp-sb-text-section" {...attrs}>
      {eyebrow && <span className="fp-sb-eyebrow">{eyebrow}</span>}
      {title && <h2>{title}</h2>}
      {blok.content && <RichText value={blok.content}/>}
      {blok.richtext && <RichText value={blok.richtext}/>}
      {!blok.content && !blok.richtext && copy && <p>{copy}</p>}
    </section>;
  }
  if (component === "cta" || component === "call_to_action") {
    return <section className="fp-sb-cta" {...attrs}>
      <div>{eyebrow && <span className="fp-sb-eyebrow">{eyebrow}</span>}{title && <h2>{title}</h2>}{copy && <p>{copy}</p>}</div>
      <ActionLink label={textValue(blok.button_label) || textValue(blok.primary_label) || "Learn more"} value={blok.button_link ?? blok.primary_link}/>
    </section>;
  }
  if (children.length) return <section className="fp-sb-section" {...attrs}>{children.map((child, index) => <Block key={child._uid ?? index} blok={child}/>)}</section>;
  if (title || copy) return <section className="fp-sb-section fp-sb-text-section" {...attrs}>{title && <h2>{title}</h2>}{copy && <p>{copy}</p>}</section>;
  return null;
}

export default function StoryblokPublicPage({ slug }: { slug: string }) {
  const preview = useMemo(isPreviewRequest, []);
  const [story, setStory] = useState<Story | null>(null);
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const controller = signal ? null : new AbortController();
    const activeSignal = signal ?? controller!.signal;
    try {
      const result = await fetchStory(slug, preview, activeSignal);
      setStory(result);
      setFailed(false);
    } catch {
      if (!activeSignal.aborted) setFailed(true);
    }
  }, [preview, slug]);

  useEffect(() => {
    if (!storyblokIsConfigured()) {
      setFailed(true);
      return;
    }
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  useEffect(() => {
    if (!preview || !story?.id) return;
    let disposed = false;
    let bridge: Bridge | null = null;
    const onInput = (event: BridgeEvent) => {
      if (event.story?.content) {
        setStory(event.story);
        setFailed(false);
      }
    };
    const onSaved = () => { if (!disposed) void refresh(); };
    void loadBridge().then(() => {
      if (disposed || !window.StoryblokBridge) return;
      bridge = new window.StoryblokBridge();
      bridge.on(["input"], onInput);
      bridge.on(["change", "published"], onSaved);
    }).catch(() => undefined);
    return () => {
      disposed = true;
      bridge?.off?.(["input"], onInput);
      bridge?.off?.(["change", "published"], onSaved);
    };
  }, [preview, refresh, story?.id]);

  if (!story?.content || failed) return <LandingPage/>;
  return <div className="fp-storyblok-public">
    <header className="fp-sb-header">
      <a className="fp-sb-brand" href="/"><span>F</span>FlowPay</a>
      <nav aria-label="Public website"><a href="/about">About</a><a href="/services">Services</a><a className="fp-sb-login" href="/login">Log in</a></nav>
    </header>
    <Block blok={story.content}/>
    <footer className="fp-sb-footer"><a className="fp-sb-brand" href="/"><span>F</span>FlowPay</a><span>© {new Date().getFullYear()} FlowPay</span><a href="/login">Account login</a></footer>
  </div>;
}
