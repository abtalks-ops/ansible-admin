import { execFile } from "node:child_process";
import { indexStats } from "@/lib/rag";
import { toolsEnabled } from "@/lib/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function version(cmd: string): Promise<string | null> {
  return new Promise((resolve) =>
    execFile(cmd, ["--version"], { timeout: 15_000 }, (err, out) => resolve(err ? null : out.split("\n")[0].trim())),
  );
}

export async function GET() {
  const [core, lint] = await Promise.all([version("ansible"), version("ansible-lint")]);
  return Response.json({
    model: process.env.ANTHROPIC_MODEL || "claude-opus-5-5",
    apiKey: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
    docs: indexStats(),
    tools: { enabled: toolsEnabled(), ansible: core, ansibleLint: lint },
    webSearch: process.env.ENABLE_WEB_SEARCH !== "false",
    whisper: Boolean(process.env.WHISPER_URL),
  });
}
