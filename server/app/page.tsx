"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "@/components/Markdown";
import MatrixRain from "@/components/MatrixRain";
import { speak, stopSpeaking, useSpeechInput } from "@/lib/speech";

interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  output?: string;
  isError?: boolean;
}
interface Msg {
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  tools?: ToolCall[];
  error?: string;
}
interface Conversation {
  id: string;
  title: string;
  messages: Msg[];
  updatedAt: number;
}
interface Health {
  model: string;
  apiKey: boolean;
  docs: { available: boolean; chunks: number };
  tools: { enabled: boolean; ansible: string | null; ansibleLint: string | null };
  webSearch: boolean;
}

const STORE_KEY = "ansible-admin:conversations:v1";
const PREF_KEY = "ansible-admin:prefs:v1";

const SUGGESTIONS = [
  "Explain all 22 levels of Ansible variable precedence with a gotcha for each",
  "Write a production-grade role to harden SSH on RHEL 9, lint-clean",
  "How do I size automation controller and execution nodes for 5,000 hosts on AAP 2.5?",
  "Build an Event-Driven Ansible rulebook that remediates Alertmanager disk alerts",
];

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked: keep working in memory */
  }
}
const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export default function Home() {
  const [convos, setConvos] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [interim, setInterim] = useState("");
  const [busy, setBusy] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [tts, setTts] = useState(false);
  const [rain, setRain] = useState(true);
  const [health, setHealth] = useState<Health | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const hydrated = useRef(false);

  useEffect(() => {
    const c = load<Conversation[]>(STORE_KEY, []);
    setConvos(c);
    setActiveId(c[0]?.id ?? null);
    const p = load(PREF_KEY, { tts: false, rain: true });
    setTts(p.tts);
    setRain(p.rain);
    hydrated.current = true;
    fetch("/api/health").then((r) => r.json()).then(setHealth).catch(() => {});
  }, []);

  useEffect(() => {
    if (hydrated.current && !busy) save(STORE_KEY, convos);
  }, [convos, busy]);
  useEffect(() => {
    if (hydrated.current) save(PREF_KEY, { tts, rain });
  }, [tts, rain]);

  const active = useMemo(() => convos.find((c) => c.id === activeId) ?? null, [convos, activeId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) el.scrollTop = el.scrollHeight;
  }, [active?.messages]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 240) + "px";
  }, [input, interim]);

  const speech = useSpeechInput(
    (text) => setInput((prev) => (prev ? prev.trimEnd() + " " : "") + text),
    setInterim,
  );

  const patchLast = useCallback((cid: string, fn: (m: Msg) => Msg) => {
    setConvos((cs) =>
      cs.map((c) => (c.id === cid ? { ...c, messages: [...c.messages.slice(0, -1), fn(c.messages[c.messages.length - 1])], updatedAt: Date.now() } : c)),
    );
  }, []);

  const send = useCallback(
    async (text: string) => {
      const prompt = text.trim();
      if (!prompt || busy) return;
      speech.stop();
      stopSpeaking();
      setInput("");
      setInterim("");

      let cid = activeId;
      let history: Msg[] = active?.messages ?? [];
      if (!cid || !active) {
        cid = newId();
        history = [];
        setConvos((cs) => [{ id: cid!, title: prompt.slice(0, 60), messages: [], updatedAt: Date.now() }, ...cs]);
        setActiveId(cid);
      }
      const userMsg: Msg = { role: "user", content: prompt };
      setConvos((cs) =>
        cs.map((c) => (c.id === cid ? { ...c, messages: [...history, userMsg, { role: "assistant", content: "", tools: [] }], updatedAt: Date.now() } : c)),
      );
      setBusy(true);
      const ac = new AbortController();
      abortRef.current = ac;
      let finalText = "";

      try {
        const payload = [...history, userMsg]
          .filter((m) => m.content.trim())
          .map((m) => ({ role: m.role, content: m.content }));
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: payload }),
          signal: ac.signal,
        });
        if (!res.ok || !res.body) {
          const err = await res.json().catch(() => ({ error: res.statusText }));
          throw new Error(err.error || `HTTP ${res.status}`);
        }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (!line.trim()) continue;
            const ev = JSON.parse(line);
            if (ev.type === "text") {
              finalText += ev.text;
              patchLast(cid!, (m) => ({ ...m, content: m.content + ev.text }));
            } else if (ev.type === "thinking") {
              patchLast(cid!, (m) => ({ ...m, thinking: (m.thinking ?? "") + ev.text }));
            } else if (ev.type === "tool") {
              patchLast(cid!, (m) => {
                const tools = m.tools ?? [];
                const i = tools.findIndex((t) => t.id === ev.id);
                if (i >= 0) return { ...m, tools: tools.map((t, j) => (j === i ? { ...t, input: ev.input ?? t.input } : t)) };
                return { ...m, tools: [...tools, { id: ev.id, name: ev.name, input: ev.input }] };
              });
            } else if (ev.type === "tool_result") {
              patchLast(cid!, (m) => ({ ...m, tools: (m.tools ?? []).map((t) => (t.id === ev.id ? { ...t, output: ev.output, isError: ev.isError } : t)) }));
            } else if (ev.type === "error") {
              patchLast(cid!, (m) => ({ ...m, error: ev.message }));
            }
          }
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") patchLast(cid!, (m) => ({ ...m, error: (err as Error).message }));
      } finally {
        setBusy(false);
        abortRef.current = null;
        if (tts && finalText) speak(finalText);
      }
    },
    [active, activeId, busy, patchLast, speech, tts],
  );

  const newChat = () => {
    setActiveId(null);
    setSidebarOpen(false);
    stopSpeaking();
    taRef.current?.focus();
  };
  const deleteChat = (id: string) => {
    setConvos((cs) => cs.filter((c) => c.id !== id));
    if (id === activeId) setActiveId(null);
  };

  const status = health
    ? [
        health.apiKey ? "api ✓" : "api ✗ (set ANTHROPIC_API_KEY)",
        health.docs.available ? `docs ${health.docs.chunks.toLocaleString()} chunks` : "docs not indexed",
        health.tools.ansible ? "ansible ✓" : "ansible ✗",
        health.tools.ansibleLint ? "lint ✓" : "lint ✗",
        health.webSearch ? "web ✓" : "web off",
      ]
    : ["connecting…"];

  return (
    <div className="app">
      <MatrixRain enabled={rain} />

      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="brand">
          <span className="logo">▲</span> ansible<span className="dim">_</span>admin
        </div>
        <button className="new-chat" onClick={newChat}>
          + new conversation
        </button>
        <nav className="convos">
          {convos.length === 0 && <p className="muted small">No conversations yet.</p>}
          {convos.map((c) => (
            <div key={c.id} className={`convo ${c.id === activeId ? "active" : ""}`}>
              <button
                className="convo-title"
                onClick={() => {
                  setActiveId(c.id);
                  setSidebarOpen(false);
                }}
                title={c.title}
              >
                {c.title}
              </button>
              <button className="convo-del" onClick={() => deleteChat(c.id)} aria-label="Delete conversation">
                ×
              </button>
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <label className="toggle">
            <input type="checkbox" checked={tts} onChange={(e) => (setTts(e.target.checked), !e.target.checked && stopSpeaking())} /> read replies aloud
          </label>
          <label className="toggle">
            <input type="checkbox" checked={rain} onChange={(e) => setRain(e.target.checked)} /> digital rain
          </label>
          <div className="status">
            {health?.model && <div>{health.model}</div>}
            {status.map((s) => (
              <div key={s}>{s}</div>
            ))}
          </div>
        </div>
      </aside>
      {sidebarOpen && <div className="scrim" onClick={() => setSidebarOpen(false)} />}

      <main className="main">
        <header className="topbar">
          <button className="menu" onClick={() => setSidebarOpen((o) => !o)} aria-label="Toggle sidebar">
            ☰
          </button>
          <span className="topbar-title">{active?.title ?? "new conversation"}</span>
        </header>

        <div className="scroll" ref={scrollRef}>
          {!active || active.messages.length === 0 ? (
            <div className="empty">
              <h1 className="glow">
                wake up, admin<span className="cursor">_</span>
              </h1>
              <p className="muted">Ask anything about Ansible, from Jinja2 edge cases to AAP mesh topology. Type, or press the mic and talk.</p>
              <div className="suggestions">
                {SUGGESTIONS.map((s) => (
                  <button key={s} onClick={() => send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="thread">
              {active.messages.map((m, i) => (
                <MessageView
                  key={i}
                  m={m}
                  streaming={busy && i === active.messages.length - 1}
                  onSpeak={() => speak(m.content)}
                />
              ))}
            </div>
          )}
        </div>

        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
        >
          <div className="composer-box">
            <textarea
              ref={taRef}
              rows={1}
              value={interim ? `${input}${input ? " " : ""}${interim}` : input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send(input);
                }
              }}
              placeholder={speech.listening ? "listening…" : "Ask Ansible Admin…"}
              aria-label="Message"
            />
            <div className="composer-actions">
              {speech.supported && (
                <button
                  type="button"
                  className={`icon ${speech.listening ? "rec" : ""}`}
                  onClick={() => (speech.listening ? speech.stop() : speech.start())}
                  aria-label={speech.listening ? "Stop listening" : "Speak"}
                  title={speech.mode === "whisper" ? "Speak (Whisper)" : "Speak"}
                >
                  {speech.listening ? "■" : "🎙"}
                </button>
              )}
              {busy ? (
                <button type="button" className="icon send" onClick={() => abortRef.current?.abort()} aria-label="Stop">
                  ■
                </button>
              ) : (
                <button type="submit" className="icon send" disabled={!input.trim()} aria-label="Send">
                  ↑
                </button>
              )}
            </div>
          </div>
          <div className="composer-hint">
            {speech.error ? <span className="err">{speech.error}</span> : "Enter to send · Shift+Enter for a new line · answers can be wrong; check before running in production"}
          </div>
        </form>
      </main>
    </div>
  );
}

const TOOL_LABELS: Record<string, string> = {
  search_ansible_docs: "searched docs",
  ansible_lint: "ran ansible-lint",
  ansible_syntax_check: "ran syntax-check",
  ansible_doc: "read ansible-doc",
  web_search: "searched the web",
};

function toolSummary(t: ToolCall) {
  const inp = (t.input ?? {}) as Record<string, unknown>;
  const detail = (inp.query ?? inp.plugin ?? inp.filename ?? "") as string;
  return `${TOOL_LABELS[t.name] ?? t.name}${detail ? `: ${detail}` : ""}`;
}

function MessageView({ m, streaming, onSpeak }: { m: Msg; streaming: boolean; onSpeak: () => void }) {
  if (m.role === "user") {
    return (
      <div className="msg user">
        <div className="bubble">{m.content}</div>
      </div>
    );
  }
  const waiting = streaming && !m.content && !m.error;
  return (
    <div className="msg assistant">
      <div className="avatar">▲</div>
      <div className="body">
        {m.thinking && (
          <details className="thinking">
            <summary>{streaming && !m.content ? "thinking…" : "thought process"}</summary>
            <div className="thinking-text">{m.thinking}</div>
          </details>
        )}
        {m.tools?.map((t) => (
          <details key={t.id} className={`tool ${t.isError ? "tool-err" : ""}`}>
            <summary>
              {t.output === undefined ? "◌" : t.isError ? "✗" : "✓"} {toolSummary(t)}
            </summary>
            {t.input != null && (
              <pre className="tool-io">{typeof t.input === "string" ? t.input : JSON.stringify(t.input, null, 2)}</pre>
            )}
            {t.output !== undefined && <pre className="tool-io out">{t.output}</pre>}
          </details>
        ))}
        {waiting && !m.thinking && (m.tools?.length ?? 0) === 0 && <div className="pending">decoding the matrix<span className="cursor">_</span></div>}
        {m.content && <Markdown text={m.content} />}
        {streaming && m.content && <span className="cursor">▌</span>}
        {m.error && <div className="error">⚠ {m.error}</div>}
        {!streaming && m.content && (
          <div className="msg-actions">
            <button onClick={() => navigator.clipboard.writeText(m.content)}>copy</button>
            <button onClick={onSpeak}>read aloud</button>
            <button onClick={stopSpeaking}>stop</button>
          </div>
        )}
      </div>
    </div>
  );
}
