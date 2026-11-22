// Basic 認証の資格情報を作り、CloudFront KeyValueStore に入れるハッシュ値を表示する。
// - パスワードは引数で渡さない（シェル履歴に残さない）。何も入力しなければ十分に長いランダム値を生成する
// - 表示されたパスワードはパスワードマネージャーに保存する。ファイルやリポジトリには書かない
// - KVS に入れるのはハッシュ値だけ
import { createHash, randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const user = (await rl.question("ユーザー名 [me]: ")).trim() || "me";
let password = (await rl.question("パスワード（空ならランダム生成）: ")).trim();
rl.close();
if (!password) password = randomBytes(24).toString("base64url");
if (password.length < 20) {
  console.error("パスワードは 20 文字以上にしてください（試行回数の制限がないため）。");
  process.exit(1);
}
if (user.includes(":")) {
  console.error("ユーザー名に ':' は使えません。");
  process.exit(1);
}
const token = Buffer.from(`${user}:${password}`, "utf8").toString("base64");
const hash = createHash("sha256").update(token).digest("hex");
console.log("");
console.log(`ユーザー名: ${user}`);
console.log(`パスワード: ${password}   ← パスワードマネージャーに保存し、この画面は閉じる`);
console.log(`KVS に入れる値（basic-auth-sha256）: ${hash}`);
