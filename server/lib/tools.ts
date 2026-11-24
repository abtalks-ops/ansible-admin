// Client-side tools Claude can call: docs search plus real Ansible CLIs.
// Every input is validated with zod before anything runs, and CLIs are run with
// execFile (no shell) inside a throwaway temp directory with a timeout.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { searchDocs, indexStats } from "./rag";

const MAX_OUT = 20_000;
const PLUGIN_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.]*$/;

const SearchInput = z.object({
  query: z.string().min(2).max(500),
  source: z.string().max(60).optional(),
  k: z.number().int().min(1).max(12).optional(),
});
const LintInput = z.object({
  content: z.string().min(1).max(200_000),
  filename: z.string().regex(/^[A-Za-z0-9_.-]+\.ya?ml$/).optional(),
  profile: z.enum(["min", "basic", "moderate", "safety", "shared", "production"]).optional(),
});
const SyntaxInput = z.object({
  playbook: z.string().min(1).max(200_000),
  inventory: z.string().max(50_000).optional(),
});
const DocInput = z.object({
  plugin: z.string().regex(PLUGIN_NAME).max(200),
  type: z
    .enum(["module", "become", "cache", "callback", "cliconf", "connection", "filter", "httpapi", "inventory", "lookup", "netconf", "shell", "strategy", "test", "vars", "keyword"])
    .optional(),
  snippet: z.boolean().optional(),
});

export function toolsEnabled() {
  return process.env.ENABLE_ANSIBLE_TOOLS !== "false";
}

export function toolDefinitions(): Anthropic.Beta.BetaToolUnion[] {
  const defs: Anthropic.Beta.BetaToolUnion[] = [
    {
      name: "search_ansible_docs",
      description:
        "Search the local index of official Ansible documentation (ansible-core docs, collection guides, AWX/AAP, Event-Driven Ansible, ansible-lint, ansible-navigator, ansible-builder, module docs). Returns the most relevant passages with source URLs. Use exact terms: module FQCNs, option names, config keys, error text.",
      eager_input_streaming: true,
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keywords or a question, e.g. 'variable precedence extra vars role defaults'." },
          source: { type: "string", description: "Optional filter by source name, e.g. 'ansible-lint', 'awx', 'rulebook', 'ansible-core'." },
          k: { type: "integer", description: "Number of passages to return (1-12, default 6)." },
        },
        required: ["query"],
      },
    },
  ];
  if (!toolsEnabled()) return defs;
  defs.push(
    {
      name: "ansible_lint",
      description:
        "Run ansible-lint on a single YAML file (playbook, task file, or rulebook) and return the findings. Use it to check any Ansible YAML you write or review.",
      eager_input_streaming: true,
      input_schema: {
        type: "object",
        properties: {
          content: { type: "string", description: "Full YAML file content." },
          filename: { type: "string", description: "File name to lint as, e.g. site.yml or tasks/main.yml basename. Default playbook.yml." },
          profile: { type: "string", enum: ["min", "basic", "moderate", "safety", "shared", "production"], description: "ansible-lint profile. Default production." },
        },
        required: ["content"],
      },
    },
    {
      name: "ansible_syntax_check",
      description:
        "Run `ansible-playbook --syntax-check` on a playbook. Parses the playbook without executing any task. Returns the parser output or errors.",
      eager_input_streaming: true,
      input_schema: {
        type: "object",
        properties: {
          playbook: { type: "string", description: "Full playbook YAML." },
          inventory: { type: "string", description: "Optional INI or YAML inventory content. Defaults to localhost only." },
        },
        required: ["playbook"],
      },
    },
    {
      name: "ansible_doc",
      description:
        "Run `ansible-doc` to read the real documentation of an installed module or plugin (options, defaults, return values, examples), or a task snippet. Use FQCNs like ansible.builtin.copy or community.general.ufw.",
      eager_input_streaming: true,
      input_schema: {
        type: "object",
        properties: {
          plugin: { type: "string", description: "Plugin FQCN, e.g. ansible.builtin.template." },
          type: { type: "string", description: "Plugin type. Default module.", enum: ["module", "become", "cache", "callback", "cliconf", "connection", "filter", "httpapi", "inventory", "lookup", "netconf", "shell", "strategy", "test", "vars", "keyword"] },
          snippet: { type: "boolean", description: "Return a ready-to-paste task snippet instead of the full doc." },
        },
        required: ["plugin"],
      },
    },
  );
  return defs;
}

function run(cmd: string, args: string[], cwd: string, timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...process.env,
          ANSIBLE_NOCOLOR: "1",
          NO_COLOR: "1",
          ANSIBLE_FORCE_COLOR: "0",
          ANSIBLE_RETRY_FILES_ENABLED: "0",
          ANSIBLE_DEPRECATION_WARNINGS: "False",
          ANSIBLE_SYSTEM_WARNINGS: "False",
          ANSIBLE_LOCAL_TEMP: path.join(cwd, ".ansible-tmp"),
          HOME: process.env.HOME ?? cwd,
        },
      },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: unknown }) | null;
        if (e?.code === "ENOENT") return resolve(`ERROR: \`${cmd}\` is not installed on the server. Install it with: pip install ansible-core ansible-lint`);
        if (e?.killed) return resolve(`ERROR: ${cmd} timed out after ${timeoutMs / 1000}s`);
        const exit = e ? `exit code ${typeof e.code === "number" ? e.code : 1}` : "exit code 0";
        const out = `${exit}\n${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`.trim();
        resolve(out.length > MAX_OUT ? out.slice(0, MAX_OUT) + "\n... [truncated]" : out);
      },
    );
  });
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ansible-admin-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Runs a client tool. Returns [content, isError]. */
export async function executeTool(name: string, input: unknown): Promise<[string, boolean]> {
  try {
    switch (name) {
      case "search_ansible_docs": {
        const p = SearchInput.safeParse(input);
        if (!p.success) return [`Invalid input: ${p.error.message}`, true];
        if (!indexStats().available)
          return ["The docs index has not been built on this server (run `npm run ingest`). Answer from your own knowledge and say the answer was not checked against the docs.", true];
        const hits = searchDocs(p.data.query, p.data.k ?? 6, p.data.source);
        if (!hits.length) return ["No matching passages. Try different keywords (module FQCN, option name, error text).", false];
        return [
          hits.map((h, i) => `[${i + 1}] ${h.source} | ${h.title}\nURL: ${h.url}\n${h.text}`).join("\n\n---\n\n"),
          false,
        ];
      }
      case "ansible_lint": {
        if (!toolsEnabled()) return ["Ansible tools are disabled on this server.", true];
        const p = LintInput.safeParse(input);
        if (!p.success) return [`Invalid input: ${p.error.message}`, true];
        return [
          await withTempDir(async (dir) => {
            const file = p.data.filename ?? "playbook.yml";
            await fs.writeFile(path.join(dir, file), p.data.content);
            // Mark the dir as a project root so lint doesn't walk up the tree.
            await fs.mkdir(path.join(dir, ".git"));
            return run("ansible-lint", ["--nocolor", "--offline", "--format=pep8", "--profile", p.data.profile ?? "production", file], dir, 90_000);
          }),
          false,
        ];
      }
      case "ansible_syntax_check": {
        if (!toolsEnabled()) return ["Ansible tools are disabled on this server.", true];
        const p = SyntaxInput.safeParse(input);
        if (!p.success) return [`Invalid input: ${p.error.message}`, true];
        return [
          await withTempDir(async (dir) => {
            await fs.writeFile(path.join(dir, "playbook.yml"), p.data.playbook);
            let inv = "localhost,";
            if (p.data.inventory) {
              inv = path.join(dir, "inventory");
              await fs.writeFile(inv, p.data.inventory);
            }
            return run("ansible-playbook", ["--syntax-check", "-i", inv, "playbook.yml"], dir);
          }),
          false,
        ];
      }
      case "ansible_doc": {
        if (!toolsEnabled()) return ["Ansible tools are disabled on this server.", true];
        const p = DocInput.safeParse(input);
        if (!p.success) return [`Invalid input: ${p.error.message}`, true];
        const args = ["-t", p.data.type ?? "module"];
        if (p.data.snippet) args.push("-s");
        args.push(p.data.plugin);
        return [await withTempDir((dir) => run("ansible-doc", args, dir, 30_000)), false];
      }
      default:
        return [`Unknown tool: ${name}`, true];
    }
  } catch (err) {
    return [`Tool failed: ${(err as Error).message}`, true];
  }
}
