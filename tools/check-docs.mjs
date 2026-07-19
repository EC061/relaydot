import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const ignored = new Set([
  ".git",
  ".next",
  ".pytest_cache",
  ".venv",
  "coverage",
  "dist",
  "node_modules"
]);

function markdownFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    if (ignored.has(entry)) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      files.push(...markdownFiles(path));
    } else if (entry.endsWith(".md")) {
      files.push(path);
    }
  }
  return files;
}

const failures = [];
const linkPattern = /!?\[[^\]]*]\(([^)]+)\)/g;
for (const file of markdownFiles(root)) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(linkPattern)) {
    let target = match[1].trim().replace(/^<|>$/g, "");
    if (
      target === "" ||
      target.startsWith("#") ||
      /^(https?:|mailto:)/.test(target)
    ) {
      continue;
    }
    target = decodeURIComponent(target.split("#", 1)[0]);
    const destination = resolve(dirname(file), target);
    if (!existsSync(destination)) {
      failures.push(`${file.slice(root.length + 1)} -> ${target}`);
    }
  }
}

for (const required of [
  ".github/workflows/deploy-controller.yml",
  "infra/compose/compose.yaml",
  "infra/compose/.env.example",
  "infra/scripts/backup-controller.sh",
  "infra/scripts/deploy-controller.sh",
  "infra/scripts/restore-controller.sh",
  "infra/tests/deployment-scripts.sh"
]) {
  if (!existsSync(join(root, required))) {
    failures.push(`missing required deployment file: ${required}`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("documentation links and deployment files are valid");
