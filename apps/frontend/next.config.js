/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Ensure workspace package resolution works smoothly
  transpilePackages: ['@sonicflow/shared'],
};

module.exports = nextConfig;
