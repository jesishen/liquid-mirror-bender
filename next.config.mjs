/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false, // avoid double-mounting the camera/GL loop in dev
  devIndicators: false,   // hides the "N" badge
};

export default nextConfig;
