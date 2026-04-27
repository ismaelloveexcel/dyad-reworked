/**
 * factory_deploy.ts — PR #11: One-click deploy (Vercel first, Netlify second)
 *
 * Deploys the scaffolded app's dist/ directory to Vercel or Netlify using
 * their REST APIs directly (no CLI dependency).
 *
 * - Vercel:  inline file upload via POST /v13/deployments
 * - Netlify: SHA1-digest deploy via POST /api/v1/sites/:siteId/deploys
 *            followed by PUT uploads for required files
 *
 * Both providers read their access token from encrypted user settings.
 */

import { createTypedHandler } from "./base";
import { factoryContracts } from "../types/factory";
import { DyadError, DyadErrorKind } from "@/errors/dyad_error";
import { db } from "@/db";
import { factoryRuns } from "@/db/schema";
import { eq } from "drizzle-orm";
import log from "electron-log";
import { app } from "electron";
import { readdir, readFile, stat } from "fs/promises";
import { createHash } from "crypto";
import path from "node:path";
import { readSettings, writeSettings } from "@/main/settings";
import { factorySlugFromName } from "@/core/factory/main";
import type { IdeaEvaluationResult } from "../types/factory";

const logger = log.scope("factory_deploy");

// =============================================================================
// Constants
// =============================================================================

const DEPLOY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes — shared by Vercel and Netlify

/** Max concurrent file uploads to Netlify to avoid throttling / FD pressure. */
const NETLIFY_UPLOAD_CONCURRENCY = 5;

const VERCEL_API_BASE = "https://api.vercel.com";
const NETLIFY_API_BASE = "https://api.netlify.com/api/v1";

// =============================================================================
// File collection helpers
// =============================================================================

/**
 * Recursively collect all files in a directory.
 * Returns a Map of relative POSIX path → Buffer.
 */
async function collectFiles(
  dir: string,
  base = dir,
): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  const entries = await readdir(dir);
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const s = await stat(full);
    if (s.isDirectory()) {
      const nested = await collectFiles(full, base);
      for (const [k, v] of nested) result.set(k, v);
    } else {
      const relPath = path.relative(base, full).split(path.sep).join("/");
      result.set(relPath, await readFile(full));
    }
  }
  return result;
}

// Heuristic: treat these extensions as text (utf-8); everything else base64.
const TEXT_EXTENSIONS = new Set([
  ".html",
  ".css",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".txt",
  ".md",
  ".svg",
  ".xml",
  ".yaml",
  ".yml",
  ".map",
  ".ts",
  ".tsx",
]);

function isTextFile(relPath: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(relPath).toLowerCase());
}

// =============================================================================
// Abort-signal helper
// =============================================================================

/**
 * Create an AbortController + timer pair.
 * Call `clear()` in a `finally` block to prevent timer leaks.
 */
function withTimeout(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

// =============================================================================
// Concurrency pool
// =============================================================================

/**
 * Run `tasks` with at most `concurrency` items in flight simultaneously.
 * Rejects immediately if any task throws (matching Promise.all semantics).
 */
async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  const results: T[] = [];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < tasks.length) {
      const index = nextIndex++;
      results[index] = await tasks[index]();
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    worker,
  );
  await Promise.all(workers);
  return results;
}

// =============================================================================
// Vercel deploy (inline file upload)
// =============================================================================

/**
 * Deploy a static directory to Vercel using the REST API.
 * Files are uploaded inline (utf-8 text or base64 binary) in a single request.
 * Returns the HTTPS deployment URL.
 */
async function deployToVercel(
  distDir: string,
  slug: string,
  token: string,
): Promise<string> {
  logger.log(`[vercel] deploying ${distDir} as "${slug}"`);

  const fileMap = await collectFiles(distDir);
  if (fileMap.size === 0) {
    throw new DyadError(
      `dist/ directory at "${distDir}" is empty — run scaffold first.`,
      DyadErrorKind.DeployFailure,
    );
  }

  // Build Vercel files payload
  const files: Array<{
    file: string;
    data: string;
    encoding: "utf-8" | "base64";
  }> = [];
  for (const [relPath, content] of fileMap) {
    const text = isTextFile(relPath);
    files.push({
      file: relPath,
      data: text ? content.toString("utf-8") : content.toString("base64"),
      encoding: text ? "utf-8" : "base64",
    });
  }

  const { signal, clear } = withTimeout(DEPLOY_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${VERCEL_API_BASE}/v13/deployments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: slug,
        files,
        projectSettings: {
          outputDirectory: ".",
          framework: null,
          buildCommand: "",
          installCommand: "",
          devCommand: "",
        },
        target: "production",
      }),
      signal,
    });
  } finally {
    clear();
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "(no body)");
    throw new DyadError(
      `Vercel API error ${response.status}: ${errorBody}`,
      DyadErrorKind.DeployFailure,
    );
  }

  const data = (await response.json()) as {
    url?: string;
    id?: string;
    error?: { message?: string };
  };

  if (data.error?.message) {
    throw new DyadError(
      `Vercel deployment error: ${data.error.message}`,
      DyadErrorKind.DeployFailure,
    );
  }

  if (!data.url) {
    throw new DyadError(
      "Vercel API returned no deployment URL.",
      DyadErrorKind.DeployFailure,
    );
  }

  return `https://${data.url}`;
}

// =============================================================================
// Netlify deploy (SHA1-digest file upload)
// =============================================================================

interface NetlifySite {
  id: string;
  name?: string;
  ssl_url?: string;
  url?: string;
  subdomain?: string;
}

interface NetlifyDeploy {
  id: string;
  required?: string[];
  ssl_url?: string;
  url?: string;
  deploy_ssl_url?: string;
  error_message?: string | null;
}

/**
 * Validate the Netlify token by fetching the current user.
 *
 * Returns `false` only when Netlify explicitly rejects the credentials
 * (HTTP 401 or 403).  Throws a {@link DyadError} with
 * {@link DyadErrorKind.DeployFailure} for any other HTTP status or network
 * error, so the caller can surface a "check your connection and retry"
 * message rather than the misleading "invalid token" message.
 */
async function validateNetlifyToken(token: string): Promise<boolean> {
  const { signal, clear } = withTimeout(DEPLOY_TIMEOUT_MS);
  try {
    const response = await fetch(`${NETLIFY_API_BASE}/user`, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });

    if (response.status === 401 || response.status === 403) {
      return false;
    }

    if (response.ok) {
      return true;
    }

    throw new DyadError(
      `Unable to validate Netlify token right now (Netlify API returned ${response.status}). Please try again.`,
      DyadErrorKind.DeployFailure,
    );
  } catch (err) {
    if (err instanceof DyadError) throw err;
    throw new DyadError(
      `Unable to reach Netlify to validate the token. Please check your network connection and try again.`,
      DyadErrorKind.DeployFailure,
    );
  } finally {
    clear();
  }
}

/**
 * Deploy a static directory to Netlify using the REST API.
 *
 * 1. Create (or reuse) a site with a deterministic name `<slug>-<runId>`.
 *    On site-name conflict the existing site is reused so retries are
 *    idempotent.
 * 2. POST file digest map to start the deploy.
 * 3. Upload files that Netlify marks as required (max {@link NETLIFY_UPLOAD_CONCURRENCY}
 *    concurrent connections to avoid throttling).
 *
 * Returns the HTTPS site URL.
 */
async function deployToNetlify(
  distDir: string,
  slug: string,
  runId: number,
  token: string,
): Promise<string> {
  const siteName = `${slug}-${runId}`;
  logger.log(`[netlify] deploying ${distDir} as "${siteName}"`);

  const fileMap = await collectFiles(distDir);
  if (fileMap.size === 0) {
    throw new DyadError(
      `dist/ directory at "${distDir}" is empty — run scaffold first.`,
      DyadErrorKind.DeployFailure,
    );
  }

  // Compute SHA1 digest for each file (Netlify content-addressing)
  const fileDigests = new Map<string, string>(); // "/" + relPath → sha1
  for (const [relPath, content] of fileMap) {
    fileDigests.set(
      "/" + relPath,
      createHash("sha1").update(content).digest("hex"),
    );
  }

  const authHeader = { Authorization: `Bearer ${token}` } as const;

  // -------------------------------------------------------------------------
  // Step 1 — Create site (idempotent: reuse on name conflict)
  // -------------------------------------------------------------------------
  let site: NetlifySite;
  {
    const { signal, clear } = withTimeout(DEPLOY_TIMEOUT_MS);
    let siteResponse: Response;
    try {
      siteResponse = await fetch(`${NETLIFY_API_BASE}/sites`, {
        method: "POST",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ name: siteName }),
        signal,
      });
    } finally {
      clear();
    }

    if (siteResponse.ok) {
      site = (await siteResponse.json()) as NetlifySite;
    } else {
      // Name may already be taken (e.g. previous deploy attempt failed after
      // site creation). Attempt to look it up and reuse.
      const createErrorBody = await siteResponse
        .text()
        .catch(() => "(no body)");

      const { signal: listSignal, clear: listClear } =
        withTimeout(DEPLOY_TIMEOUT_MS);
      let listResponse: Response;
      try {
        listResponse = await fetch(`${NETLIFY_API_BASE}/sites`, {
          headers: authHeader,
          signal: listSignal,
        });
      } finally {
        listClear();
      }

      if (!listResponse.ok) {
        const listErrorBody = await listResponse
          .text()
          .catch(() => "(no body)");
        throw new DyadError(
          `Failed to create Netlify site: ${siteResponse.status} ${createErrorBody}. Failed to list existing sites: ${listResponse.status} ${listErrorBody}`,
          DyadErrorKind.DeployFailure,
        );
      }

      const allSites = (await listResponse.json()) as NetlifySite[];
      const existing = allSites.find((s) => s.name === siteName);
      if (!existing) {
        throw new DyadError(
          `Failed to create Netlify site: ${siteResponse.status} ${createErrorBody}`,
          DyadErrorKind.DeployFailure,
        );
      }
      logger.log(
        `[netlify] Reusing existing site "${siteName}" (${existing.id}) after create conflict`,
      );
      site = existing;
    }
  }

  // -------------------------------------------------------------------------
  // Step 2 — Create deploy with file digest map
  // -------------------------------------------------------------------------
  const filesObj: Record<string, string> = {};
  for (const [p, sha] of fileDigests) filesObj[p] = sha;

  let deploy: NetlifyDeploy;
  {
    const { signal, clear } = withTimeout(DEPLOY_TIMEOUT_MS);
    let deployResponse: Response;
    try {
      deployResponse = await fetch(
        `${NETLIFY_API_BASE}/sites/${site.id}/deploys`,
        {
          method: "POST",
          headers: { ...authHeader, "Content-Type": "application/json" },
          body: JSON.stringify({ files: filesObj }),
          signal,
        },
      );
    } finally {
      clear();
    }

    if (!deployResponse.ok) {
      const errorBody = await deployResponse.text().catch(() => "(no body)");
      throw new DyadError(
        `Failed to start Netlify deploy: ${deployResponse.status} ${errorBody}`,
        DyadErrorKind.DeployFailure,
      );
    }

    deploy = (await deployResponse.json()) as NetlifyDeploy;
    if (deploy.error_message) {
      throw new DyadError(
        `Netlify deploy error: ${deploy.error_message}`,
        DyadErrorKind.DeployFailure,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Step 3 — Upload required files (bounded concurrency)
  // -------------------------------------------------------------------------
  const required = new Set(deploy.required ?? []);

  const uploadTasks: Array<() => Promise<void>> = [];
  for (const [relPath, content] of fileMap) {
    const sha = fileDigests.get("/" + relPath);
    if (!sha || !required.has(sha)) continue;

    // Encode file path segments individually (preserve directory separators)
    const encodedPath = relPath
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");

    uploadTasks.push(async () => {
      const { signal, clear } = withTimeout(DEPLOY_TIMEOUT_MS);
      let uploadResponse: Response;
      try {
        uploadResponse = await fetch(
          `${NETLIFY_API_BASE}/deploys/${deploy.id}/files/${encodedPath}`,
          {
            method: "PUT",
            headers: {
              ...authHeader,
              "Content-Type": "application/octet-stream",
            },
            body: content.buffer.slice(
              content.byteOffset,
              content.byteOffset + content.byteLength,
            ) as ArrayBuffer,
            signal,
          },
        );
      } finally {
        clear();
      }

      if (!uploadResponse.ok) {
        const errorBody = await uploadResponse.text().catch(() => "(no body)");
        throw new DyadError(
          `Failed to upload file "${relPath}": ${uploadResponse.status} ${errorBody}`,
          DyadErrorKind.DeployFailure,
        );
      }
    });
  }

  if (uploadTasks.length > 0) {
    logger.log(
      `[netlify] uploading ${uploadTasks.length} required file(s) (concurrency ${NETLIFY_UPLOAD_CONCURRENCY})`,
    );
    await runWithConcurrency(uploadTasks, NETLIFY_UPLOAD_CONCURRENCY);
  }

  // Prefer ssl_url → url → fallback
  const siteUrl =
    deploy.deploy_ssl_url ??
    deploy.ssl_url ??
    deploy.url ??
    site.ssl_url ??
    site.url ??
    `https://${siteName}.netlify.app`;

  logger.log(`[netlify] deployed: ${siteUrl}`);
  return siteUrl;
}

// =============================================================================
// Handler registration
// =============================================================================

export function registerFactoryDeployHandlers(): void {
  // ---------------------------------------------------------------------------
  // factory:deploy-app
  // ---------------------------------------------------------------------------
  createTypedHandler(
    factoryContracts.deployApp,
    async (_, { runId, provider }) => {
      // Load run from DB to derive the slug
      const rows = await db
        .select({ ideaJson: factoryRuns.ideaJson })
        .from(factoryRuns)
        .where(eq(factoryRuns.id, runId))
        .limit(1);

      if (rows.length === 0) {
        throw new DyadError(
          `No factory run found with id ${runId}.`,
          DyadErrorKind.NotFound,
        );
      }

      let ideaName: string;
      try {
        const idea = JSON.parse(rows[0].ideaJson) as IdeaEvaluationResult;
        ideaName = idea.name;
      } catch {
        throw new DyadError(
          `Failed to parse idea JSON for run ${runId}.`,
          DyadErrorKind.FactoryPersistenceFailure,
        );
      }

      const slug = factorySlugFromName(ideaName, runId);
      const appDir = path.join(app.getPath("userData"), "factory-apps", slug);
      const distDir = path.join(appDir, "dist");

      // -----------------------------------------------------------------------
      // PR #15 — Checkout gate: block deploy when VITE_CHECKOUT_URL is not
      // configured in the scaffolded app's .env.
      //
      // Reads the .env file in the scaffolded app directory. If the file is
      // missing or the variable is not set to a non-empty value, throw a clear
      // Precondition error asking the user to configure checkout first.
      // -----------------------------------------------------------------------
      let checkoutConfigured = false;
      try {
        const envPath = path.join(appDir, ".env");
        const envContent = await readFile(envPath, "utf-8");
        const match = envContent.match(/VITE_CHECKOUT_URL\s*=\s*(.+)/);
        if (match && match[1].trim().length > 0) {
          checkoutConfigured = true;
        }
      } catch {
        // .env absent or unreadable
      }

      if (!checkoutConfigured) {
        throw new DyadError(
          "Checkout is not configured. Add VITE_CHECKOUT_URL before deploying.",
          DyadErrorKind.Precondition,
        );
      }

      // Verify dist/ exists
      try {
        const s = await stat(distDir);
        if (!s.isDirectory()) {
          throw new DyadError(
            `dist/ at "${distDir}" is not a directory. Run scaffold first.`,
            DyadErrorKind.DeployFailure,
          );
        }
      } catch (err) {
        if (err instanceof DyadError) throw err;
        throw new DyadError(
          `dist/ not found at "${distDir}". Run scaffold first.`,
          DyadErrorKind.DeployFailure,
        );
      }

      const settings = readSettings();

      if (provider === "vercel") {
        const token = settings.vercelAccessToken?.value;
        if (!token) {
          throw new DyadError(
            "No Vercel access token configured. Save your token in Settings → Vercel.",
            DyadErrorKind.Auth,
          );
        }
        try {
          const url = await deployToVercel(distDir, slug, token);
          logger.log(`[factory:deploy-app] Vercel deploy succeeded: ${url}`);
          return { url, provider: "vercel" as const };
        } catch (err) {
          if (err instanceof DyadError) throw err;
          throw new DyadError(
            `Vercel deploy failed: ${err instanceof Error ? err.message : String(err)}`,
            DyadErrorKind.DeployFailure,
          );
        }
      }

      // provider === "netlify"
      const token = settings.netlifyAccessToken?.value;
      if (!token) {
        throw new DyadError(
          "No Netlify access token configured. Save your token using the Netlify token field.",
          DyadErrorKind.Auth,
        );
      }
      try {
        const url = await deployToNetlify(distDir, slug, runId, token);
        logger.log(`[factory:deploy-app] Netlify deploy succeeded: ${url}`);
        return { url, provider: "netlify" as const };
      } catch (err) {
        if (err instanceof DyadError) throw err;
        throw new DyadError(
          `Netlify deploy failed: ${err instanceof Error ? err.message : String(err)}`,
          DyadErrorKind.DeployFailure,
        );
      }
    },
  );

  // ---------------------------------------------------------------------------
  // factory:save-netlify-token
  // ---------------------------------------------------------------------------
  createTypedHandler(
    factoryContracts.saveNetlifyToken,
    async (_, { token }) => {
      if (!token || token.trim() === "") {
        throw new DyadError(
          "Netlify access token is required.",
          DyadErrorKind.Auth,
        );
      }

      const trimmed = token.trim();
      const valid = await validateNetlifyToken(trimmed);
      if (!valid) {
        throw new DyadError(
          "Invalid Netlify token. Please check your personal access token and try again.",
          DyadErrorKind.Auth,
        );
      }

      writeSettings({ netlifyAccessToken: { value: trimmed } });
      logger.log("Saved Netlify access token.");
    },
  );

  logger.log("Registered factory deploy IPC handlers");
}
