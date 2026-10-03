// tsc rewrites relative ".ts" imports to ".js" in emitted JavaScript but not in
// declaration files; do the same for dist/**/*.d.ts so published types resolve.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const relativeTsImport = /(from\s+|import\(\s*)(["'])(\.{1,2}\/[^"']+)\.ts\2/g;

for (const entry of readdirSync("dist", { recursive: true, encoding: "utf8" })) {
  if (!entry.endsWith(".d.ts")) continue;
  const path = join("dist", entry);
  const source = readFileSync(path, "utf8");
  const fixed = source.replace(relativeTsImport, "$1$2$3.js$2");
  if (fixed !== source) writeFileSync(path, fixed);
}
