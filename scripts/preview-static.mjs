// 静的エクスポート（out/）を、S3（REST オリジン）+ CloudFront に近い挙動で配信するローカル確認用サーバー。
// - "/" だけ index.html を返す（CloudFront の Default root object 相当）
// - それ以外はキーの完全一致のみ（サブディレクトリの index.html 補完はしない）
// - 見つからなければ 404.html を 404 で返す（カスタムエラーレスポンス相当）
// - /data/ は LOCAL_PUBLIC_DIR（既定 public/data）から返す（S3 の data/ 相当）
// - PREVIEW_AUTH_HASH を設定すると、本番と同じ CloudFront Function（infra/app/functions/basic-auth.js）を
//   すべてのリクエストの前に実行する（KVS の代わりに環境変数の値を使う）。npm run auth:hash で値を作れる
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

const root = path.resolve("out");
const dataDir = path.resolve(process.env.LOCAL_PUBLIC_DIR || "public/data");
const port = Number(process.env.PORT || 3000);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".ico": "image/x-icon", ".svg": "image/svg+xml", ".woff2": "font/woff2" };

let auth = null;
if (process.env.PREVIEW_AUTH_HASH) {
  const code = readFileSync("infra/app/functions/basic-auth.js", "utf8").replace(/^import cf from 'cloudfront';$/m, "");
  const cf = { kvs: () => ({ get: async () => process.env.PREVIEW_AUTH_HASH }) };
  auth = new Function("cf", "require", `${code}\nreturn handler;`)(cf, () => ({ createHash }));
}

function resolveKey(urlPath) {
  const key = decodeURIComponent(urlPath === "/" ? "/index.html" : urlPath);
  const [base, rel] = key.startsWith("/data/") ? [dataDir, key.slice("/data/".length)] : [root, key.slice(1)];
  const file = path.resolve(base, rel);
  if (!file.startsWith(base + path.sep)) return null;
  return existsSync(file) && statSync(file).isFile() ? file : null;
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (auth) {
    const headers = req.headers.authorization ? { authorization: { value: req.headers.authorization } } : {};
    const r = await auth({ request: { uri: url.pathname, headers } });
    if (r.statusCode) {
      res.writeHead(r.statusCode, Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k, v.value])));
      return res.end(r.body);
    }
  }
  const file = resolveKey(url.pathname);
  const send = (status, f) => {
    res.writeHead(status, { "content-type": types[path.extname(f)] ?? "application/octet-stream" });
    createReadStream(f).pipe(res);
  };
  if (file) return send(200, file);
  const notFound = path.join(root, "404.html");
  if (existsSync(notFound)) return send(404, notFound);
  res.writeHead(404).end("not found");
}).listen(port, () =>
  console.log(`preview: http://localhost:${port} (out/ + ${path.relative(process.cwd(), dataDir)} as /data)${auth ? " with Basic auth" : " WITHOUT auth"}`),
);
