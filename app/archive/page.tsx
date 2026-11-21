import { ArchivePage } from "../../src/web/components/views";
import { getReader } from "../../src/web/reader";

export const dynamic = "force-dynamic";

export default async function Archive() {
  return <ArchivePage view={await getReader().archive()} />;
}
