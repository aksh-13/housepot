/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  serverExternalPackages: ["pg"],
  experimental: { serverActions: { bodySizeLimit: "10mb" } },
};

export default nextConfig;
