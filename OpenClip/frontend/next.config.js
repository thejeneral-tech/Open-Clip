const path = require("path");
const os = require("os");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
  // Hide the dev-only "Static route" lightning-bolt indicator at the bottom of the page.
  devIndicators: { appIsrStatus: false },
  webpack: (config, { dev }) => {
    // This project lives inside a OneDrive folder, which locks files as it syncs and
    // EPERMs Next's webpack pack-file cache under .next/cache — corrupting incremental
    // builds and causing phantom "Cannot find module for page" 404s (e.g. on the
    // dashboards) right after edits. Keep the build cache on a non-synced temp dir so
    // incremental compilation stays reliable.
    if (dev && config.cache && config.cache.type === "filesystem") {
      config.cache.cacheDirectory = path.join(os.tmpdir(), "openclip-next-cache");
    }
    return config;
  },
  async rewrites() {
    // In dev, proxy API + media through Next so the browser hits one origin.
    // Use 127.0.0.1, not "localhost": on Windows Node resolves "localhost" to
    // IPv6 ::1 first, but uvicorn binds IPv4 127.0.0.1 only → ECONNREFUSED.
    const apiBase = process.env.BACKEND_INTERNAL_URL || "http://127.0.0.1:8000";
    return [
      { source: "/api/:path*", destination: `${apiBase}/api/:path*` },
      { source: "/media/:path*", destination: `${apiBase}/media/:path*` },
    ];
  },
};

module.exports = nextConfig;
