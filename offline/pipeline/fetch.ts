// Step 1: fetch. Sparse, shallow checkouts of each source; returns the commit SHA
// so the nightly job can diff from it (phase 3).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { RAW_DIR, type RepoSource } from "./config.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();

export function fetchSource(s: RepoSource, reuse = false): { dir: string; sha: string } {
  const dest = path.join(RAW_DIR, `${s.repo.replace("/", "__")}@${s.ref}`);
  if (!(reuse && fs.existsSync(path.join(dest, ".git")))) {
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    git(dest, "init", "-q");
    git(dest, "remote", "add", "origin", `https://github.com/${s.repo}.git`);
    git(dest, "sparse-checkout", "set", s.dir);
    git(dest, "fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", s.ref);
    git(dest, "checkout", "-q", "FETCH_HEAD");
  }
  return { dir: path.join(dest, s.dir), sha: git(dest, "rev-parse", "HEAD") };
}
