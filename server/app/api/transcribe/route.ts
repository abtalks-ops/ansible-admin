// Optional Whisper fallback for browsers without the Web Speech API (e.g. Firefox).
// Forwards recorded audio to any OpenAI-compatible /audio/transcriptions endpoint,
// such as a local whisper.cpp or faster-whisper server.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 25 * 1024 * 1024;

export async function POST(req: Request) {
  const url = process.env.WHISPER_URL;
  if (!url) return Response.json({ error: "Whisper fallback is not configured (set WHISPER_URL)." }, { status: 501 });

  const form = await req.formData().catch(() => null);
  const audio = form?.get("audio");
  if (!(audio instanceof Blob)) return Response.json({ error: "Missing audio" }, { status: 400 });
  if (audio.size > MAX_BYTES) return Response.json({ error: "Audio too large (25 MB max)" }, { status: 413 });

  const upstream = new FormData();
  upstream.append("file", audio, "speech.webm");
  upstream.append("model", process.env.WHISPER_MODEL || "whisper-1");
  // Bias recognition toward Ansible vocabulary.
  upstream.append("prompt", "Ansible, playbook, inventory, AAP, AWX, Event-Driven Ansible, rulebook, ansible-lint, Jinja2, YAML, become, handlers, FQCN");

  const headers: Record<string, string> = {};
  if (process.env.WHISPER_API_KEY) headers.Authorization = `Bearer ${process.env.WHISPER_API_KEY}`;

  const res = await fetch(url, { method: "POST", body: upstream, headers });
  if (!res.ok) return Response.json({ error: `Transcription failed (${res.status})` }, { status: 502 });
  const data = (await res.json().catch(() => ({}))) as { text?: string };
  return Response.json({ text: (data.text ?? "").trim() });
}

export async function GET() {
  return Response.json({ enabled: Boolean(process.env.WHISPER_URL) });
}
