/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The docs index can be large; keep it out of the client bundle.
  outputFileTracingIncludes: { "/api/chat": ["./data/index.json"] },
};
export default nextConfig;
