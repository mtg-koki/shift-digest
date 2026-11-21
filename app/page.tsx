import { ReportPage, parseCategory } from "../src/web/components/views";
import { getReader } from "../src/web/reader";

// Blob のデータをリクエスト時に読む（ビルド時に固定しない）。日次更新で再デプロイ不要。
export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const view = await getReader().latest();
  return <ReportPage view={view} category={parseCategory(sp.category)} basePath="/" />;
}
