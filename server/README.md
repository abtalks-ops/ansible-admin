# Ansible Admin

Your go-to expert Ansible administrator: a Claude-style chat app in a Matrix theme that answers anything from YAML syntax and Jinja2 edge cases to Ansible Automation Platform (AAP) architecture, Event-Driven Ansible and execution environments. You can type or talk to it, and it can read its replies aloud.

It is more than a chat window over a model. Three things make it an expert rather than a generalist:

1. **An expert system prompt** (`lib/systemPrompt.ts`) that sets the scope (ansible-core, collections, AAP/AWX, EDA, execution environments, lint, Windows, network, cloud) and the working habits of a principal engineer: cite sources, be precise about versions, write lint-clean FQCN code, and explain the next gotcha.
2. **Retrieval over the official docs (RAG).** `npm run ingest` downloads the Ansible documentation and indexes it locally. The model searches it with the `search_ansible_docs` tool, so answers are grounded in the current docs instead of memory.
3. **Real tools.** The model runs `ansible-lint`, `ansible-playbook --syntax-check` and `ansible-doc` on the server to check the code it writes and read exact module options. It can also search the live web, limited to Ansible and Red Hat domains, for anything newer than the index.

## Features

- Claude-style layout: conversation sidebar (saved in your browser), streaming Markdown answers, syntax-highlighted code blocks with copy buttons, collapsible "thought process" and tool-call panels.
- Matrix theme: black and green, monospace fonts, subtle digital rain (toggle in the sidebar; it switches off for "reduce motion").
- Speech input: the mic button uses the browser's Web Speech API (Chrome, Edge, Safari). In browsers without it (Firefox), it records audio and sends it to a Whisper server if you configure one.
- Text-to-speech: tick "read replies aloud", or use "read aloud" under any answer. Code blocks are announced rather than read out.
- Model: `claude-opus-5-5` with adaptive thinking and `high` effort by default.

## Quick start

Requirements: Node.js 20+ and Python 3.10+ (for the Ansible tools).

```bash
cd server
npm install
pip install ansible ansible-lint        # full community package, so ansible-doc knows every module

cp .env.example .env.local              # then put your key in it (see below)
npm run ingest -- --modules             # downloads and indexes the docs, ~2-5 minutes
npm run dev                             # open http://localhost:3000
```

The sidebar footer shows what is working: API key, number of indexed doc chunks, ansible, ansible-lint and web search.

### Getting and setting the API key

1. Sign in at https://console.anthropic.com, add billing credit, and create a key under **Settings > API keys**.
2. Put it in `.env.local` (this file is git-ignored):

   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```

3. Restart `npm run dev`. The key stays on the server; the browser never sees it.

Other settings in `.env.example`:

| Variable | Default | What it does |
|---|---|---|
| `ANTHROPIC_MODEL` | `claude-opus-5-5` | Model to use |
| `ANTHROPIC_EFFORT` | `high` | Reasoning depth: `low`, `medium`, `high`, `xhigh`, `max`. Lower is faster and cheaper. |
| `ENABLE_WEB_SEARCH` | `true` | Live web search limited to docs.ansible.com, Red Hat docs, GitHub, Galaxy and the Ansible forum |
| `ENABLE_ANSIBLE_TOOLS` | `true` | Lets the model run ansible-lint, syntax-check and ansible-doc on the server |
| `WHISPER_URL` | unset | Whisper fallback for speech input (see below) |

## The docs index (RAG)

`npm run ingest` clones the doc folders listed in `data/sources.json` and writes `data/index.json`:

| Source | Covers |
|---|---|
| ansible/ansible-documentation | ansible-core user, playbook, inventory, vault, network, Windows, dev and porting guides |
| ansible/awx | AWX (upstream of automation controller) admin and user docs |
| ansible/ansible-rulebook, ansible/eda-server | Event-Driven Ansible |
| ansible/ansible-lint (docs and every rule page) | Lint rules and profiles |
| ansible-navigator, ansible-builder, ansible-runner | Execution environments and tooling |
| molecule, receptor | Role testing, automation mesh |
| `--modules` | Every module and plugin installed on the server (options, defaults, examples), from `ansible-doc --metadata-dump` |

Useful options:

```bash
npm run ingest -- --local ./my-docs      # add your own folder (.md, .rst, .txt, .html)
npm run ingest -- --only lint            # rebuild only matching sources
npm run ingest -- --skip-clone           # re-index without downloading again
```

**Red Hat AAP product docs** (installation, the platform gateway, operator installs, sizing) are published on docs.redhat.com and are not in a public git repo. Download the guides you care about as HTML, put them in a folder and add it with `--local`. Web search also covers docs.redhat.com when it is enabled. Your own runbooks, standards and past incident notes are also worth adding this way; that is how the assistant learns things specific to your estate.

Retrieval uses BM25 keyword search. It needs no embedding service, runs offline, and works well for Ansible's exact vocabulary (module names, option names, `ANSIBLE_*` variables, error text). If you later want semantic search, swap `searchDocs` in `lib/rag.ts` for a vector store; the tool interface stays the same.

Re-run ingest every few weeks, or after upgrading ansible, to keep it current.

## Speech

- **Web Speech API** (default): no setup. Chrome and Edge send audio to the browser vendor's speech service; Safari uses on-device or Apple recognition.
- **Whisper fallback**: set `WHISPER_URL` to any OpenAI-compatible `/audio/transcriptions` endpoint. For a fully local option, run a self-hosted Whisper server that speaks that API (for example speaches, formerly faster-whisper-server, or the whisper.cpp server) and point the app at it:

  ```
  WHISPER_URL=http://localhost:9000/v1/audio/transcriptions
  WHISPER_MODEL=<the model name your server expects>
  ```

  The app sends an Ansible vocabulary hint (playbook, AAP, rulebook, FQCN and so on) to improve recognition.
- **Text-to-speech** uses the browser's built-in voices, so it needs no setup.

## Running with Docker

The image includes Node, ansible, ansible-lint and the full collection set, and builds the docs index during the build:

```bash
docker build -t ansible-admin .
docker run -p 3000:3000 -e ANTHROPIC_API_KEY=sk-ant-... ansible-admin
```

## Security notes

- The lint, syntax-check and ansible-doc tools only parse YAML. They never run tasks or connect to hosts. Each run happens in a throwaway temp directory with a timeout, and is called without a shell. Inputs are validated before anything runs.
- ansible-lint can still import collection plugins while it parses. If you expose the app beyond your own machine, run it in the Docker image (non-root user), put it behind authentication, or set `ENABLE_ANSIBLE_TOOLS=false`.
- The app has no login. Do not put it on the public internet as-is: anyone who reaches it spends your API credit.
- Conversations are stored only in your browser's local storage.

## Project layout

```
app/page.tsx              Chat UI (sidebar, streaming, tool panels, mic, TTS toggles)
app/api/chat/route.ts     Claude API loop: streaming, tool calls, web search, refusal fallback
app/api/transcribe        Whisper fallback proxy
app/api/health            Status shown in the sidebar
components/               Matrix rain canvas, Markdown with copyable code blocks
lib/systemPrompt.ts       The expert persona
lib/tools.ts              search_ansible_docs, ansible_lint, ansible_syntax_check, ansible_doc
lib/rag.ts                BM25 search over data/index.json
lib/speech.ts             Speech recognition and synthesis
scripts/ingest.ts         Builds the docs index
data/sources.json         Which doc repos to index
```

## Ideas for next steps

- Connect it to your automation controller read-only (job templates, failed job stdout, inventories) as extra tools, so it can debug real failed jobs.
- Add an `ansible-navigator`/molecule sandbox tool that runs playbooks against throwaway containers.
- Add authentication (for example NextAuth with your SSO) and server-side conversation storage for a team.
- Build an eval set of hard Ansible questions with known answers, to measure changes to the prompt or retrieval.
