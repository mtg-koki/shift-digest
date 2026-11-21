import Link from "next/link";

export default function NotFound() {
  return (
    <p className="empty">
      ページが見つかりません。<Link href="/">最新のまとめへ</Link>
    </p>
  );
}
