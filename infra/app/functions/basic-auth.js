// CloudFront Functions (cloudfront-js-2.0) / viewer-request
// 自分専用にするための Basic 認証。すべてのパス（HTML・アセット・/data/ の JSON・過去データ）に適用する。
// - viewer-request はキャッシュ判定より前に毎回実行されるため、キャッシュ済みのコンテンツも認証なしでは返らない
// - 期待値は CloudFront KeyValueStore のキー "basic-auth-sha256"（"user:password" を Base64 にした文字列の SHA-256 16進）
//   値は Terraform ではなく CLI で投入する（Git・Terraform state・フロントエンドに秘密値を置かない）
// - キーが未設定・読み取り失敗のときは全員を拒否する（fail closed）
import cf from 'cloudfront';

const crypto = require('crypto');
const kvs = cf.kvs();
const KEY = 'basic-auth-sha256';
const REALM = 'shift-digest';

function unauthorized() {
  return {
    statusCode: 401,
    statusDescription: 'Unauthorized',
    headers: {
      'www-authenticate': { value: 'Basic realm="' + REALM + '", charset="UTF-8"' },
      'cache-control': { value: 'no-store' },
      'content-type': { value: 'text/plain; charset=utf-8' },
    },
    body: 'Authentication required',
  };
}

// 長さが同じ 16 進文字列を、内容によらず同じ手順で比較する
function sameHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length !== 64) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function handler(event) {
  const request = event.request;
  const header = request.headers.authorization;
  const value = header && header.value;
  if (!value || value.length > 1024 || value.slice(0, 6).toLowerCase() !== 'basic ') return unauthorized();

  let expected;
  try {
    expected = await kvs.get(KEY);
  } catch (e) {
    return unauthorized();
  }
  if (!expected) return unauthorized();

  const token = value.slice(6).trim();
  const actual = crypto.createHash('sha256').update(token).digest('hex');
  if (!sameHex(actual, String(expected).trim().toLowerCase())) return unauthorized();

  // 認証情報はオリジン（S3）へ送らない
  delete request.headers.authorization;
  return request;
}
