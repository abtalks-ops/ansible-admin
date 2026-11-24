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

- First open: it shows the download size and downloads everything into Cache Storage with progress. It asks for persistent storage so the browser doesn't evict the index.
- Updates: it compares the remote manifest with the installed one and downloads only the shard files that are new. Shard file names change whenever their content changes. The new manifest is swapped in only after every file is cached, so a half-finished download never breaks search.
- Search: keyword search is ready as soon as the index loads, and semantic search joins once the embedder has loaded (about 1 to 2 s). Results show highlighted matches, the source link and the licence, with copy buttons on code blocks.
- Offline: a service worker serves the app shell and all downloaded files. This was tested by loading and searching in Chromium with the network switched off.

## Commands

```bash
cd offline
npm ci
pip install "ansible-core>=2.22,<2.23"     # for the ansible.builtin plugin docs
./scripts/fetch-model.sh                    # embedder files, pinned revision, into models/

npm run build:index                         # -> dist/index (shards + manifest), chunks/ansible-core-2.22.jsonl
npm run eval -- --set eval/smoke.jsonl      # or --set <golden.jsonl> --subset <pilot_meta.json>
npm run build:pwa                           # -> pwa/dist (static site)
npm run serve                               # http://localhost:8080
```

To try it on a phone, serve `pwa/dist` over HTTPS (service workers need it), for example with GitHub Pages. See CI below.

## Contributing enrichment

Add one file per chunk at `enrichment/<chunk_hash>.json`. Chunk hashes are listed in `chunks/ansible-core-2.22.jsonl`.

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

`answer_card` is optional (null or left out). Files are validated when the index is built, and invalid ones are skipped with a warning. A file whose hash no longer matches any chunk is ignored.

## CI

`.github/workflows/offline-index.yml` runs nightly, on demand and on pull requests that touch `offline/`. It builds the index, runs the retrieval gate, builds the PWA and uploads it as a build artifact. Deploying to GitHub Pages is a manual step: run the workflow with `deploy: true` after enabling Pages in the repo settings. It's manual because the design doc says the licence checks come before publishing.

## AI answers on the device (phase 2, small models)

Optional. In the settings panel (⚙), **Turn on AI answers** checks the device for WebGPU, asks before downloading the model (700 to 950 MB; you choose between Llama 3.2 1B, Qwen 2.5 1.5B and Gemma 3 1B, all 4-bit, through WebLLM), and keeps it in the browser's Cache Storage so it works offline afterwards. Then a **Write an answer on this device** button appears under each search.

- The model is given only the top 4 passages (about 5,000 characters) and told to cite them as `[1]`, `[2]`. Citations that don't point at a real passage are removed, each cited source is listed under the answer, and a reply of `NOT_IN_DOCS` becomes "the docs on this device don't seem to answer that".
- The WebLLM library (6 MB) is a separate bundle, `vendor/web-llm.js`, fetched only when AI is turned on. The 63 MB first install is unchanged.
- Delete downloaded data also removes the model.
- Testing without a GPU: open the app with `?llm=mock` for a canned model. The model picker is in the same panel and switching downloads the new model if needed. To try a model that is not in the picker, add `?model=<WebLLM model id>`.
- `npm test` covers the prompt, citation and not-in-docs logic. Answer quality of the real model has **not** been measured yet: the build machine can't download it and has no GPU. That needs a device run.

## Known limits and next steps

- The smoke-set gate in CI uses 40 questions. Switch it to the golden set once that can live in the repo.
- Some sections produce several adjacent chunks, so the same heading can appear more than once in the results. Grouping results by section is a small UI follow-up.
- The embedder used for the numbers above was quantized locally from the official fp32 export, because this build machine can't reach huggingface.co. CI uses the official `model_quantized.onnx` at a pinned revision, so its numbers may differ slightly.
- Phase 2 still to do: compare 2 or 3 small models on golden questions on a real device, then the Standard tier. Phase 3: other sources and nightly deltas.
