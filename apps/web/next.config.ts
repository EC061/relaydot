import path from "node:path";
import { fileURLToPath } from "node:url";

import type { NextConfig } from "next";

const directory = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(directory, "../.."),
  serverExternalPackages: [
    "@russellthehippo/honker-node",
    "better-sqlite3"
  ]
};

export default nextConfig;
