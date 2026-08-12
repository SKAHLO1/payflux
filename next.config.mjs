/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  // The SDK is consumed straight from source in this monorepo so the demo store needs no
  // build step. See the note in packages/sdk/package.json.
  transpilePackages: ["@payflux/node"],
}

export default nextConfig
