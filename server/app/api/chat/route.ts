// Streams an answer as newline-delimited JSON events:
//   {type:"thinking", text}  {type:"text", text}  {type:"tool", id, name, input}
//   {type:"tool_result", id, output, isError}  {type:"done", stopReason}  {type:"error", message}
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { SYSTEM_PROMPT } from "@/lib/systemPrompt";
import { executeTool, toolDefinitions } from "@/lib/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const client = new Anthropic();
const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";
const EFFORT = (process.env.ANTHROPIC_EFFORT || "high") as "low" | "medium" | "high" | "xhigh" | "max";
const MAX_ITERATIONS = 12;

const Body = z.object({
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(400_000) }))
    .min(1)
    .max(200),
});

const WEB_DOMAINS = [
  "docs.ansible.com",
  "ansible.readthedocs.io",
  "github.com",
  "galaxy.ansible.com",
  "forum.ansible.com",
  "docs.redhat.com",
  "access.redhat.com",
  "developers.redhat.com",
  "www.redhat.com",
];

function buildTools(): Anthropic.Beta.BetaToolUnion[] {
  const tools = toolDefinitions();
  if (process.env.ENABLE_WEB_SEARCH !== "false") {
    tools.push({ type: "web_search_20260209", name: "web_search", max_uses: 5, allowed_domains: WEB_DOMAINS });
  }
  return tools;
}

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request body" }, { status: 400 });
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    return Response.json({ error: "ANTHROPIC_API_KEY is not set on the server. See README." }, { status: 500 });
  }

  const messages: Anthropic.Beta.BetaMessageParam[] = parsed.data.messages.map((m) => ({ role: m.role, content: m.content }));
  const tools = buildTools();
  const encoder = new TextEncoder();

  const body = new ReadableStream({
    async start(controller) {
      const send = (ev: Record<string, unknown>) => controller.enqueue(encoder.encode(JSON.stringify(ev) + "\n"));
      let retries = 0;
      try {
        for (let i = 0; i < MAX_ITERATIONS; i++) {
          const stream = client.beta.messages.stream(
            {
              model: MODEL,
              max_tokens: 64000,
              system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
              thinking: { type: "adaptive", display: "summarized" },
              output_config: { effort: EFFORT },
              tools,
              messages,
              // On a safety-classifier decline, the API re-runs the request on a fallback model.
              betas: ["server-side-fallback-2026-07-01"],
              fallbacks: "default",
            },
            { signal: req.signal },
          );

          stream.on("text", (delta) => send({ type: "text", text: delta }));
          stream.on("thinking", (delta) => send({ type: "thinking", text: delta }));
          stream.on("streamEvent", (ev) => {
            if (ev.type === "content_block_start" && ev.content_block.type === "server_tool_use") {
              send({ type: "tool", id: ev.content_block.id, name: ev.content_block.name, input: null });
            }
          });

          let message: Anthropic.Beta.BetaMessage;
          try {
            message = await stream.finalMessage();
            retries = 0;
          } catch (err) {
            // Unparseable tool input or a dropped connection: re-issue the turn. API errors bubble up.
            if (err instanceof Anthropic.APIError || req.signal.aborted || retries++ >= 2) throw err;
            continue;
          }

          // Surface server-side web search results.
          for (const b of message.content) {
            if (b.type === "server_tool_use") send({ type: "tool", id: b.id, name: b.name, input: b.input });
            if (b.type === "web_search_tool_result") {
              const c = b.content;
              const output = Array.isArray(c)
                ? c.map((r) => `${r.title}\n${r.url}`).join("\n\n")
                : `Search error: ${(c as { error_code?: string }).error_code ?? "unknown"}`;
              send({ type: "tool_result", id: b.tool_use_id, output, isError: !Array.isArray(c) });
            }
          }

          if (message.stop_reason === "refusal") {
            send({ type: "text", text: "\n\n_The model declined to continue this request._" });
            send({ type: "done", stopReason: "refusal" });
            return;
          }
          if (message.stop_reason === "pause_turn") {
            messages.push({ role: "assistant", content: message.content });
            continue;
          }

          const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
          if (message.stop_reason !== "tool_use" || toolUses.length === 0) {
            send({ type: "done", stopReason: message.stop_reason });
            return;
          }

          messages.push({ role: "assistant", content: message.content });
          const results = await Promise.all(
            toolUses.map(async (t) => {
              send({ type: "tool", id: t.id, name: t.name, input: t.input });
              const [output, isError] = await executeTool(t.name, t.input);
              send({ type: "tool_result", id: t.id, output, isError });
              return { type: "tool_result" as const, tool_use_id: t.id, content: output, is_error: isError };
            }),
          );
          // All results for one assistant turn go back in a single user message.
          messages.push({ role: "user", content: results });
        }
        send({ type: "text", text: "\n\n_Stopped after too many tool steps. Ask me to continue._" });
        send({ type: "done", stopReason: "max_iterations" });
      } catch (err) {
        if (!req.signal.aborted) {
          const message =
            err instanceof Anthropic.AuthenticationError
              ? "The Anthropic API key was rejected. Check ANTHROPIC_API_KEY."
              : err instanceof Anthropic.RateLimitError
                ? "Rate limited by the Anthropic API. Try again in a moment."
                : err instanceof Anthropic.APIError
                  ? `Anthropic API error ${err.status ?? ""}: ${err.message}`
                  : `Server error: ${(err as Error).message}`;
          send({ type: "error", message });
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(body, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform" },
  });
}
