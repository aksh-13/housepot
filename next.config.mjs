/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  serverExternalPackages: ["pg", "nodemailer"],
  experimental: { serverActions: { bodySizeLimit: "10mb" } },
};

export default nextConfig;
