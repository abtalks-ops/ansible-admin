// Grounded answer prompt and citation handling for the on-device model.
// Pure functions, no DOM or Node APIs: used by the PWA and by tests.
import type { Chunk } from "./search.ts";

export const NOT_IN_DOCS = "NOT_IN_DOCS";

/**
 * How much of the retrieved text goes to the model. Small models have short contexts and phones have little GPU
 * memory and a watchdog that resets the GPU after long jobs, so prompts are short. "lite" is used after a GPU reset.
 */
export interface Budget {
  passages: number;
  passageChars: number;
  totalChars: number;
  maxTokens: number; // cap on the answer length
}
export const PROFILES = {
  normal: { passages: 3, passageChars: 800, totalChars: 2400, maxTokens: 350 },
  lite: { passages: 2, passageChars: 600, totalChars: 1200, maxTokens: 250 },
} satisfies Record<string, Budget>;

/** Errors that mean the GPU or its device went away (out of memory, watchdog reset, tab backgrounded), not a bad prompt. */
export const isDeviceLost = (message: string) => /mapAsync|external Instance|device (was )?lost|GPUDevice|context lost|out of memory|OOM|destroyed|Device is lost/i.test(message);

export const SYSTEM_PROMPT = `You are Ansible Admin, an expert on Ansible. Answer the question using ONLY the numbered documentation passages the user provides.
Rules:
- Cite the passage for every claim like [1] or [2]. Never cite a number that was not provided.
- Copy module names, option names and YAML from the passages exactly. Do not invent options, modules or versions.
- Put YAML and commands in fenced code blocks.
- Be brief: a direct answer first, then at most a short example.
- If the passages do not answer the question, reply with exactly ${NOT_IN_DOCS} and nothing else.`;

/** Cut text at a paragraph or line boundary near the limit, never in the middle of a code fence if avoidable. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const at = Math.max(cut.lastIndexOf("\n\n"), cut.lastIndexOf("\n"));
  let out = (at > max * 0.5 ? cut.slice(0, at) : cut).trimEnd();
  // Close an open code fence so the model does not continue it.
  if ((out.match(/```/g)?.length ?? 0) % 2 === 1) out += "\n```";
  return out + "\n[…]";
}

export interface Used {
  n: number; // citation number shown to the model
  chunk: Chunk;
}

export interface Prompt {
  messages: Array<{ role: "system" | "user"; content: string }>;
  used: Used[];
}

/** Builds the prompt from the top hits. Adjacent hits from the same page are kept; duplicates are not. */
export function buildPrompt(question: string, hits: Chunk[], budget: Budget = PROFILES.normal): Prompt {
  const used: Used[] = [];
  let room = budget.totalChars;
  const seen = new Set<string>();
  for (const c of hits) {
    if (used.length >= budget.passages || room < 300) break;
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    used.push({ n: used.length + 1, chunk: c });
    room -= Math.min(c.x.length, budget.passageChars);
  }
  const body = used
    .map(({ n, chunk }) => `[${n}] ${chunk.t.split(" > ").slice(-3).join(" > ")}\n${clip(chunk.x, budget.passageChars)}`)
    .join("\n\n");
  return {
    used,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Documentation passages:\n\n${body}\n\nQuestion: ${question.trim()}` },
    ],
  };
}

export const isNotInDocs = (answer: string) => answer.trim().replace(/[.`*]/g, "").toUpperCase().startsWith(NOT_IN_DOCS);

/** Citation numbers the model actually used that point at a real passage, in order of first use. */
export function citedNumbers(answer: string, used: Used[]): number[] {
  const valid = new Set(used.map((u) => u.n));
  const out: number[] = [];
  for (const m of answer.matchAll(/\[(\d{1,2})\]/g)) {
    const n = Number(m[1]);
    if (valid.has(n) && !out.includes(n)) out.push(n);
  }
  return out;
}

/** Removes citation markers that do not point at a provided passage (the model sometimes invents them). */
export function stripInvalidCitations(answer: string, used: Used[]): string {
  const valid = new Set(used.map((u) => u.n));
  return answer.replace(/\s?\[(\d{1,2})\]/g, (m, d) => (valid.has(Number(d)) ? m : ""));
}
