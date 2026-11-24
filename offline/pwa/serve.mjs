// Minimal static server for local testing: npm run serve  (http://localhost:8080)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const dir = path.join(path.dirname(new URL(import.meta.url).pathname), "dist");
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".wasm": "application/wasm" };
const port = Number(process.env.PORT ?? 8080);
http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    let file = path.normalize(path.join(dir, decodeURIComponent(url.pathname)));
    if (!file.startsWith(dir)) return res.writeHead(403).end();
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    if (!fs.existsSync(file)) return res.writeHead(404).end("not found");
    const type = types[path.extname(file)] ?? "application/octet-stream";
    const gz = /gzip/.test(req.headers["accept-encoding"] ?? "") && !/\.(png|onnx)$/.test(file);
    res.writeHead(200, { "Content-Type": type, ...(gz ? { "Content-Encoding": "gzip" } : {}) });
    const stream = fs.createReadStream(file);
    (gz ? stream.pipe(zlib.createGzip()) : stream).pipe(res);
  })
  .listen(port, () => console.log(`serving ${dir} on http://localhost:${port}`));
