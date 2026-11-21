import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  serverExternalPackages: ["@azure/identity", "@azure/storage-blob"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // 動的ページをブラウザ・中継に長くキャッシュさせない（日次更新を即反映）
          { key: "Cache-Control", value: "no-store" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
