/** @type {import('next').NextConfig} */
const isStaticBuild = process.env.BUILD_STATIC === "1";

const nextConfig = {
  output: "export",
  trailingSlash: true,
  images: {
    unoptimized: true
  },
  assetPrefix: isStaticBuild ? "./" : undefined
};

export default nextConfig;
