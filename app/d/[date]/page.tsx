import { ReportPage, parseCategory } from "../../../src/web/components/views";
import { getReader } from "../../../src/web/reader";

export const dynamic = "force-dynamic";

export default async function DatePage({
  params,
  searchParams,
}: {
  params: Promise<{ date: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ date }, sp] = await Promise.all([params, searchParams]);
  const view = await getReader().byDate(date);
  return <ReportPage view={view} category={parseCategory(sp.category)} basePath={`/d/${date}`} />;
}
