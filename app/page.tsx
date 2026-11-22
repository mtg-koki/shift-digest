import { Suspense } from "react";
import { DigestApp, Loading } from "../src/web/components/digest-app";

// 静的エクスポートされる唯一の画面。表示内容はクエリ（?date= / ?view=archive / &category=）で切り替え、
// データは実行時にブラウザーが /data/ から取得する。日次更新で Web を再ビルドしない。
export default function Home() {
  return (
    <Suspense fallback={<Loading />}>
      <DigestApp />
    </Suspense>
  );
}
