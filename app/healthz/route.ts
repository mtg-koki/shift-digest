// プロセスの生存確認のみ（ストレージには触れない）
export const dynamic = "force-dynamic";

export function GET() {
  return new Response("ok", { headers: { "content-type": "text/plain", "cache-control": "no-store" } });
}
