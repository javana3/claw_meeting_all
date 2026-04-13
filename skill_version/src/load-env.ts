/**
 * Tiny zero-dependency .env loader.
 *
 * IMPORTANT precedence (changed from prior version):
 *   .env file values OVERRIDE process.env entries.
 *
 * Why: when developing in a single workspace, the .env file is the
 * single source of truth. The previous "process.env wins" behaviour
 * silently ignored .env updates whenever a stale system-level env var
 * (e.g. left over from `setx LARK_APP_SECRET ...` during an earlier
 * tenant's testing) shadowed the new value, and the plugin would then
 * call Feishu with the wrong secret. Failing closed to "use what's in
 * .env" is far less confusing.
 *
 * Called once at plugin entry import time so configuration is available
 * before register(api) runs.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export function loadEnv(): void {
  // ESM equivalent of __dirname
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  // dist/load-env.js -> project root is two levels up
  const candidates = [
    path.resolve(__dirname, "..", ".env"),
    path.resolve(__dirname, "..", "..", ".env"),
    path.resolve(process.cwd(), ".env"),
  ];

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const text = fs.readFileSync(file, "utf-8");
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        // Override unconditionally -- see header comment for the rationale.
        process.env[key] = value;
      }
      return; // first file wins
    } catch {
      /* ignore */
    }
  }
}
