/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
  async rewrites() {
    // In dev, proxy API + media through Next so the browser hits one origin.
    const apiBase = process.env.BACKEND_INTERNAL_URL || "http://localhost:8000";
    return [
      { source: "/api/:path*", destination: `${apiBase}/api/:path*` },
      { source: "/media/:path*", destination: `${apiBase}/media/:path*` },
    ];
  },
};

module.exports = nextConfig;
