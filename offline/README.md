# Ansible Admin Offline (phase 1)

The on-device version of Ansible Admin. The Ansible docs are turned into a compact, prebuilt index on the build side. A phone downloads that index once, together with a small embedding model, and then searches it with no network and no server.

Phase 1 covers **ansible-core 2.22 only** and is **search only**: hybrid keyword + semantic search, answer cards when the index has them, and the source under every result. Local LLM answers (WebLLM) are phase 2.

## Results

| | |
|---|---|
| Passages | 4,014 (2,922 from the ansible-core docs, 1,092 from `ansible.builtin` plugin docs) |
| Index size | 14.1 MB with enrichment (17,742 int8 vectors, 6.9 MB, plus 7.2 MB of text, questions and answer cards; about 9 MB on the wire). Without enrichment it was 5.8 MB. |
| First download | about 63 MB in total: index 14.1 MB (about 9 MB compressed), embedder 34.5 MB, ONNX runtime 14.3 MB, app 0.6 MB |
| Query time | 40 to 200 ms in desktop Chromium (WASM, one thread) |

Retrieval on the 324-question golden set, without enrichment (a page-level hit counts):

| Mode | Recall@1 | Recall@5 | Recall@10 | MRR |
|---|---|---|---|---|
| Keyword (BM25) | 56.2% | 80.9% | 86.7% | 0.672 |
| Vector (bge-small, int8) | 61.4% | 83.0% | 88.3% | 0.707 |
| **Hybrid (RRF)** | **62.0%** | **86.1%** | **91.7%** | **0.727** |

With every page enriched (summary, likely questions, answer card; written with a Claude subscription):

| Mode | Recall@1 | Recall@5 | Recall@10 | MRR |
|---|---|---|---|---|
| Keyword (BM25) | 64.8% | 90.4% | 95.4% | 0.761 |
| Vector (bge-small, int8) | 66.0% | 92.0% | 96.9% | 0.772 |
| **Hybrid (RRF)** | **70.4%** | **95.1%** | **96.9%** | **0.810** |

Hybrid recall@5 went from 86.1% to 95.1% (about +9 points), and on the 107 pilot-page questions from 84 to 98. Four non-pilot questions got worse (g113, g148, g223, g303) while 33 got better. Embedding only the questions, not the card title, gives 95.4% recall@5 but lower recall@1 (68.8%) and saves 1.5 MB; the card title rows stay in. The golden set is kept outside the repo, so the enrichment writer can't see it.

## How it works

```
build side (once per change)                                   phone (offline after first open)
docs repo ──fetch──> normalize ──> chunk ──> tag ──> enrich ──> embed ──> int8 shards + manifest ──> static host
                                                      │                                               │
                         enrichment/<chunk_hash>.json ┘                       PWA downloads into Cache Storage
                         (or --enrich-api: Batch API)                          embeds the question (same model)
                                                                               BM25 + vector search, RRF fusion
```

1. **Fetch** (`pipeline/fetch.ts`): sparse, shallow checkout of `ansible/ansible-documentation` at `stable-2.22`. The commit SHA is logged for delta builds later.
2. **Normalize and chunk** (`pipeline/chunk.ts`): RST to Markdown-ish text with code blocks kept intact, split on headings into chunks of up to about 1,800 characters (300 to 500 tokens). Each `ansible.builtin` plugin gets separate chunks for synopsis, parameters, examples and return values, taken from `ansible-doc --metadata-dump`. Roadmaps, community process pages and old package porting guides are skipped.
3. **Tag**: every chunk carries its heading trail, source URL, licence and FQCN. The chunk id is a content hash, so an edited chunk gets a new id and unchanged ones keep their enrichment and vectors.
4. **Enrich** (`pipeline/enrich.ts`): applies `enrichment/<chunk_hash>.json` files (summary, likely questions, optional answer card). These are currently written with a Claude subscription. The Message Batches API path with `claude-opus-5-5` is kept behind `--enrich-api` and `--enrich-limit N` for later. It logs token usage per chunk.
5. **Embed** (`pipeline/embed.ts`): `Xenova/bge-small-en-v1.5`, quantized q8, CLS pooling. This is the same file the phone downloads. A test confirmed the browser and Node produce identical query vectors (cosine 1.000000). Each chunk gets one vector, plus one for each enrichment question and the answer card title.
6. **Package** (`pipeline/build.ts`): vectors are stored as int8 with one scale per row, in shards of up to 1,500 chunks with content-addressed file names, plus `manifest.json` (index format, embedder, shard hashes and sizes).
7. **Evaluate** (`pipeline/eval.ts`): recall@1/5/10 and MRR for keyword, vector and hybrid search, loaded from the published files exactly as the phone loads them. `--gate` fails the build if hybrid recall@5 drops by more than 2 points.

### The PWA (`pwa/`)

- Doc sets: ansible-core is always included. Red Hat Ansible Automation Platform 2.6 (3,147 passages, about 11 MB) is optional: the first screen and Settings list each doc set with its passage count and size. It is ticked by default on a desktop and unticked on a phone. Unticking it in Settings removes its shards; ticking it downloads them.
- First open: it shows the download size of the chosen doc sets and downloads them into Cache Storage with progress. It asks for persistent storage so the browser doesn't evict the index.
- Updates: it compares the remote manifest with the installed one and downloads only the shard files that are new. Shard file names change whenever their content changes. The new manifest is swapped in only after every file is cached, so a half-finished download never breaks search.
- Search: keyword search is ready as soon as the index loads, and semantic search joins once the embedder has loaded (about 1 to 2 s). Results show highlighted matches, the source link and the licence, with copy buttons on code blocks.
- Offline: a service worker serves the app shell and all downloaded files. This was tested by loading and searching in Chromium with the network switched off.

## Commands

```bash
cd offline
npm ci
pip install "ansible-core>=2.22,<2.23"     # for the ansible.builtin plugin docs
./scripts/fetch-model.sh                    # embedder files, pinned revision, into models/

npm run build:index                         # -> dist/index (shards + manifest), chunks/ansible-core-2.22.jsonl and chunks/aap-2.6.jsonl
npm run check:enrichment                    # every chunk has one valid enrichment file, card links match, no {attr} in URLs
npm run eval -- --set eval/smoke-aap.jsonl  # 32 AAP questions (report only, no gate yet)
npm run eval -- --set eval/smoke.jsonl      # or --set <golden.jsonl> --subset <pilot_meta.json>
npm run build:pwa                           # -> pwa/dist (static site)
npm run serve                               # http://localhost:8080
```

To try it on a phone, serve `pwa/dist` over HTTPS (service workers need it), for example with GitHub Pages. See CI below.

## Contributing enrichment

Add one file per chunk at `enrichment/<chunk_hash>.json`. Chunk hashes are listed in `chunks/ansible-core-2.22.jsonl` and `chunks/aap-2.6.jsonl`. The AAP chunks are built from a pinned `ansible/aap-docs` commit (`AAP_REF` in `pipeline/config.ts`), so their ids stay stable. See [NOTICE.md](NOTICE.md) for the licence of each part.

```json
{
  "chunk_id": "5ab89a9103fcccb0",
  "chunk_hash": "5ab89a9103fcccb0",
  "summary": "At most two sentences, naming the exact modules, options or settings covered.",
  "questions": ["3 to 5 questions an admin would type that this chunk answers"],
  "answer_card": { "title": "…", "answer_md": "…", "source_url": "https://docs.ansible.com/…" },
  "model": "claude-…",
  "created_at": "2026-11-24T00:00:00Z"
}
```

`answer_card` is optional (null or left out). Its `source_url` must be the chunk's own URL. Files are validated when the index is built, and invalid ones are skipped with a warning. A file whose hash no longer matches any chunk is ignored by the build, and `npm run check:enrichment` (run in CI) reports it.

## CI

`.github/workflows/offline-index.yml` runs nightly, on demand and on pull requests that touch `offline/`. It builds the index, runs the retrieval gate, builds the PWA and uploads it as a build artifact. Deploying to GitHub Pages is a manual step: run the workflow with `deploy: true` after enabling Pages in the repo settings. It's manual because the design doc says the licence checks come before publishing.

## AI answers on the device (phase 2, small models)

Optional. In settings (⚙), **Turn on AI answers** asks before downloading a model and keeps it on the device so it works offline afterwards. Two kinds of model, each running in its own Web Worker so the page stays responsive while it writes:

- **No GPU needed (the phone default):** SmolLM2 360M (q8_0 GGUF, about 390 MB) run by [wllama](https://github.com/ngxson/wllama), llama.cpp compiled to WebAssembly, with `n_gpu_layers: 0` so it never touches the GPU. This is the same file, revision and settings the offline-motivator app uses on phones. The file is kept in the browser's private file system (OPFS). Both wllama builds (`vendor/wllama.wasm`, and `vendor/wllama-compat.wasm` for browsers without JSPI or relaxed SIMD) are self-hosted, so nothing loads from a CDN.
- **Uses the GPU (WebGPU, through WebLLM):** SmolLM2 360M and LFM2.5 350M (tiny), Llama 3.2 1B, Gemma 3 1B and Qwen 2.5 1.5B, all 4-bit. On phones and tablets the 1B models are disabled. Models are kept in Cache Storage.

With AI on, every question gets an answer written on the device. The chip in the header shows which model is loaded and what it is doing, and each answer ends with `Written on this device by <model> · first word 1.2 s · 14 tokens/s · CPU`, which is how you can tell the model really ran. The AI runtimes are cached by the service worker the first time they are used (`aa-vendor-<hash>`), and **Delete downloaded data** removes the docs, both kinds of model and the chat history.

- The model is given only the top 4 passages (about 5,000 characters) and told to cite them as `[1]`, `[2]`. Citations that don't point at a real passage are removed, each cited source is listed under the answer, and a reply of `NOT_IN_DOCS` becomes "the docs on this device don't seem to answer that".
- The WebLLM library (6 MB) is a separate bundle, `vendor/web-llm.js`, fetched only when AI is turned on. The 63 MB first install is unchanged.
- Delete downloaded data also removes the model.
- Chat: each question is a turn in a chat. Chats are kept on the device (the ☰ drawer lists them, ＋ starts a new one) and are removed by Delete downloaded data. Each turn is answered on its own; earlier turns aren't passed to the model.
- Crash safeguard: the app sets a flag while the model loads or answers. If the browser died in that window, the next open turns AI off and says so. The model runs with a 2,048-token window and a shorter prompt to keep phone memory low.
- GPU resets: some phones kill the GPU job (out of memory, or a watchdog on long jobs), which shows up as errors like `mapAsync … external Instance reference no longer exists`. The app then reloads the model and retries once with a shorter prompt (2 passages, 250-token answers, marked "short mode" under the answer) and keeps using short mode until AI is turned off and on. Settings has an **AI diagnostics** box with the GPU, limits, chosen model and any error, to paste into a bug report. GPUs without 16-bit shaders get the q4f32 build of the model.
- Testing without a GPU: open the app with `?llm=mock` for a canned model (`?llm=mock-gpufail` makes the first answer fail like a GPU reset). The model picker is in the same panel and switching downloads the new model if needed. To try a model that is not in the picker, add `?model=<WebLLM model id>`.
- `npm test` covers the prompt, citation and not-in-docs logic. Answer quality of the real model has **not** been measured yet: the build machine can't download it and has no GPU. That needs a device run.

## Known limits and next steps

- A code block too long for one chunk is split at a blank line or line break and its fence is closed and reopened with the same language. A single line longer than a chunk (rare, for example long command output) is split at a space.
- The AAP smoke set has no gate yet: record a baseline from the first CI run, then gate on it like the ansible-core set.
- The smoke-set gate in CI uses 40 questions. Switch it to the golden set once that can live in the repo.
- Some sections produce several adjacent chunks, so the same heading can appear more than once in the results. Grouping results by section is a small UI follow-up.
- The embedder used for the numbers above was quantized locally from the official fp32 export, because this build machine can't reach huggingface.co. CI uses the official `model_quantized.onnx` at a pinned revision, so its numbers may differ slightly.
- Phase 2 still to do: compare 2 or 3 small models on golden questions on a real device, then the Standard tier. Phase 3: other sources and nightly deltas.
