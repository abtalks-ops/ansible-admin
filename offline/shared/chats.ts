// Chat history: pure data helpers shared by the PWA and tests. Storage itself is done by the caller.

export type TurnState = "done" | "notindocs" | "error" | "search"; // "search" = AI was off for this turn

export interface Turn {
  q: string;
  hits: string[]; // chunk ids of the search results, best first (text is re-read from the index)
  state: TurnState;
  answer?: string; // the model's answer, when there is one
  model?: string; // WebLLM model id that wrote it
  stats?: string; // e.g. "first word 1.2 s · 14 tokens/s · 210 tokens"
  note?: string; // error text
}

export interface Conv {
  id: string;
  title: string;
  ts: number;
  turns: Turn[];
}

export const MAX_CONVS = 50;
export const MAX_TURNS = 100;

export const titleFrom = (q: string) => {
  const t = q.trim().replace(/\s+/g, " ");
  return t.length > 60 ? t.slice(0, 57) + "…" : t || "New chat";
};

export const newConv = (id: string, now: number): Conv => ({ id, title: "New chat", ts: now, turns: [] });

/** Puts the conversation first (most recent) and keeps at most MAX_CONVS. */
export function upsert(list: Conv[], conv: Conv): Conv[] {
  return [conv, ...list.filter((c) => c.id !== conv.id)].slice(0, MAX_CONVS);
}

export const remove = (list: Conv[], id: string) => list.filter((c) => c.id !== id);

const STATES = new Set<TurnState>(["done", "notindocs", "error", "search"]);
const str = (v: unknown, max = 20000) => (typeof v === "string" ? v.slice(0, max) : undefined);

/** Reads stored history defensively: anything malformed is dropped rather than breaking the app. */
export function parse(raw: string | null | undefined): Conv[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: Conv[] = [];
  for (const c of data) {
    if (!c || typeof c !== "object") continue;
    const o = c as Record<string, unknown>;
    const id = str(o.id, 64);
    if (!id || !Array.isArray(o.turns)) continue;
    const turns: Turn[] = [];
    for (const t of o.turns.slice(0, MAX_TURNS)) {
      if (!t || typeof t !== "object") continue;
      const x = t as Record<string, unknown>;
      const q = str(x.q, 2000);
      if (!q || !Array.isArray(x.hits)) continue;
      const state = STATES.has(x.state as TurnState) ? (x.state as TurnState) : "search";
      turns.push({ q, hits: x.hits.filter((h): h is string => typeof h === "string").slice(0, 12), state, answer: str(x.answer), model: str(x.model, 200), stats: str(x.stats, 200), note: str(x.note, 500) });
    }
    out.push({ id, title: str(o.title, 120) ?? "New chat", ts: typeof o.ts === "number" ? o.ts : 0, turns });
  }
  return out.slice(0, MAX_CONVS);
}

export const serialize = (list: Conv[]) => JSON.stringify(list);
