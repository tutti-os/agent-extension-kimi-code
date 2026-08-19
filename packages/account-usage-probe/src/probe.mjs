import { readFile as readFileFromDisk } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";

export const ACCOUNT_USAGE_SCHEMA_VERSION = "tutti.agent.account-usage.v1";

const DEFAULT_API_BASE_URL = "https://api.kimi.com/coding/v1";
const DEFAULT_OAUTH_HOST = "https://auth.kimi.com";
const DEFAULT_OAUTH_KEY = "oauth/kimi-code";
const MANAGED_PROVIDER = "managed:kimi-code";
const MAX_RESPONSE_BYTES = 1 << 20;
const REQUEST_TIMEOUT_MS = 8_000;

const ERROR_CODES = new Set([
  "auth_required",
  "config_invalid",
  "execution_failed",
  "parse_failed",
  "rate_limited",
  "session_expired",
  "timeout"
]);

class ProbeFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

class AuthorizationFailure extends ProbeFailure {
  constructor() {
    super("session_expired");
  }
}

export async function probeKimiAccountUsage(options = {}) {
  const capturedAtUnixMs = normalizeCapturedAt(options.now?.() ?? Date.now());
  try {
    const dependencies = {
      env: options.env ?? process.env,
      fetch: options.fetch ?? globalThis.fetch,
      homeDirectory: options.homeDirectory ?? homedir,
      readFile: options.readFile ?? readFileFromDisk
    };
    const target = await resolveBillingTarget(dependencies);
    if (target.billingMode === "api") {
      return availableResult(capturedAtUnixMs, "api", []);
    }

    const accessToken = await loadAccessToken(target, dependencies.readFile);
    const payload = await fetchUsageWithCredentialRefresh(
      target,
      accessToken,
      dependencies
    );
    const quotas = parseUsageQuotas(payload, capturedAtUnixMs);
    if (quotas.length === 0) {
      throw new ProbeFailure("parse_failed");
    }
    return availableResult(capturedAtUnixMs, "subscription", quotas);
  } catch (error) {
    return errorResult(capturedAtUnixMs, stableErrorCode(error));
  }
}

function availableResult(capturedAtUnixMs, billingMode, quotas) {
  return {
    schemaVersion: ACCOUNT_USAGE_SCHEMA_VERSION,
    outcome: "available",
    capturedAtUnixMs,
    billingMode,
    quotas
  };
}

function errorResult(capturedAtUnixMs, errorCode) {
  return {
    schemaVersion: ACCOUNT_USAGE_SCHEMA_VERSION,
    outcome: "error",
    capturedAtUnixMs,
    errorCode
  };
}

async function resolveBillingTarget(dependencies) {
  const env = dependencies.env;
  if (stringValue(env.KIMI_MODEL_NAME)) {
    return { billingMode: "api" };
  }

  const home =
    stringValue(env.KIMI_CODE_HOME) ||
    path.join(dependencies.homeDirectory(), ".kimi-code");
  let config;
  try {
    const content = await readOptionalFile(
      path.join(home, "config.toml"),
      dependencies.readFile
    );
    config = content ? parseToml(content) : {};
  } catch {
    throw new ProbeFailure("config_invalid");
  }

  const defaultModel = stringValue(config.default_model);
  const models = recordValue(config.models);
  const model = recordValue(models?.[defaultModel]);
  const providerName = stringValue(model?.provider);
  const providers = recordValue(config.providers);
  const provider = recordValue(providers?.[providerName]);
  const managedProvider = recordValue(providers?.[MANAGED_PROVIDER]);

  if (providerName && providerName !== MANAGED_PROVIDER && !hasOAuth(provider)) {
    return { billingMode: "api" };
  }
  if (defaultModel && !defaultModel.startsWith("kimi-code/") && !providerName) {
    return { billingMode: "api" };
  }

  const managed =
    providerName === MANAGED_PROVIDER || hasOAuth(provider)
      ? provider
      : managedProvider;
  const credentialPath = path.join(home, "credentials", "kimi-code.json");
  const managedConfigured =
    providerName === MANAGED_PROVIDER ||
    hasOAuth(provider) ||
    defaultModel.startsWith("kimi-code/") ||
    hasOAuth(managedProvider);

  const baseUrl =
    stringValue(env.KIMI_CODE_BASE_URL) ||
    stringValue(managed?.base_url) ||
    DEFAULT_API_BASE_URL;
  const oauth = recordValue(managed?.oauth);
  const oauthStorage = stringValue(oauth?.storage) || "file";
  const oauthKey = stringValue(oauth?.key) || DEFAULT_OAUTH_KEY;
  const oauthHost =
    stringValue(env.KIMI_CODE_OAUTH_HOST) ||
    stringValue(env.KIMI_OAUTH_HOST) ||
    stringValue(oauth?.oauth_host) ||
    stringValue(oauth?.oauthHost) ||
    DEFAULT_OAUTH_HOST;
  assertTrustedManagedCredentialTarget({
    baseUrl,
    oauthHost,
    oauthKey,
    oauthStorage
  });
  const hasCredentials = managedConfigured
    ? false
    : await hasCredentialFile(credentialPath, dependencies.readFile);
  if (!managedConfigured && !hasCredentials) {
    throw new ProbeFailure("auth_required");
  }
  return {
    billingMode: "subscription",
    baseUrl: DEFAULT_API_BASE_URL,
    credentialPath
  };
}

function hasOAuth(provider) {
  return recordValue(provider?.oauth) !== null;
}

async function hasCredentialFile(credentialPath, readFile) {
  try {
    return Boolean(String(await readFile(credentialPath, "utf8")).trim());
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw new ProbeFailure("execution_failed");
  }
}

function assertTrustedManagedCredentialTarget(input) {
  const base = normalizedEndpoint(input.baseUrl, true);
  const oauthHost = normalizedEndpoint(input.oauthHost, false);
  if (
    base !== normalizedEndpoint(DEFAULT_API_BASE_URL, true) ||
    oauthHost !== normalizedEndpoint(DEFAULT_OAUTH_HOST, false) ||
    input.oauthStorage !== "file" ||
    (input.oauthKey !== DEFAULT_OAUTH_KEY && input.oauthKey !== "kimi-code")
  ) {
    throw new ProbeFailure("config_invalid");
  }
}

function normalizedEndpoint(value, allowPath) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (!allowPath && url.pathname !== "/")
    ) {
      return "";
    }
    return `${url.origin.toLowerCase()}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "";
  }
}

async function loadAccessToken(target, readFile) {
  let content;
  try {
    content = await readFile(target.credentialPath, "utf8");
  } catch {
    throw new ProbeFailure("auth_required");
  }
  try {
    const credentials = JSON.parse(content);
    const accessToken = stringValue(credentials?.access_token);
    if (!accessToken) throw new Error("missing token");
    return accessToken;
  } catch {
    throw new ProbeFailure("auth_required");
  }
}

async function fetchUsageWithCredentialRefresh(target, accessToken, dependencies) {
  try {
    return await fetchUsage(target.baseUrl, accessToken, dependencies.fetch);
  } catch (error) {
    if (!(error instanceof AuthorizationFailure)) throw error;
    const refreshedToken = await loadAccessToken(target, dependencies.readFile);
    if (refreshedToken === accessToken) throw error;
    return fetchUsage(target.baseUrl, refreshedToken, dependencies.fetch);
  }
}

async function fetchUsage(baseUrl, accessToken, fetchImplementation) {
  if (typeof fetchImplementation !== "function") {
    throw new ProbeFailure("execution_failed");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImplementation(`${baseUrl}/usages`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`
      },
      redirect: "error",
      signal: controller.signal
    });
    if (response.status === 401 || response.status === 403) {
      throw new AuthorizationFailure();
    }
    if (response.status === 429) {
      throw new ProbeFailure("rate_limited");
    }
    if (!response.ok) {
      throw new ProbeFailure("execution_failed");
    }
    const body = await readResponseTextBounded(response);
    try {
      return JSON.parse(body);
    } catch {
      throw new ProbeFailure("parse_failed");
    }
  } catch (error) {
    if (error instanceof ProbeFailure) throw error;
    if (error?.name === "AbortError") throw new ProbeFailure("timeout");
    throw new ProbeFailure("execution_failed");
  } finally {
    clearTimeout(timeout);
  }
}

async function readResponseTextBounded(response) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new ProbeFailure("parse_failed");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      byteLength += chunk.byteLength;
      if (byteLength > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ProbeFailure("parse_failed");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, byteLength).toString("utf8");
}

function parseUsageQuotas(payload, capturedAtUnixMs) {
  const root = recordValue(payload);
  if (!root) throw new ProbeFailure("parse_failed");
  const quotas = [];
  const usage = recordValue(root.usage);
  if (root.usage !== undefined && !usage) {
    throw new ProbeFailure("parse_failed");
  }
  const summary = usageRowToQuota({
    row: usage,
    quotaType: "weekly",
    capturedAtUnixMs
  });
  if (summary) quotas.push(summary);

  if (root.limits !== undefined && !Array.isArray(root.limits)) {
    throw new ProbeFailure("parse_failed");
  }
  for (const rawLimit of root.limits ?? []) {
    const limit = recordValue(rawLimit);
    if (!limit) throw new ProbeFailure("parse_failed");
    const quotaType = quotaTypeFromWindow(recordValue(limit.window));
    if (!quotaType) throw new ProbeFailure("parse_failed");
    const detail = recordValue(limit.detail) ??
      (limit.detail === undefined ? limit : null);
    if (!detail) throw new ProbeFailure("parse_failed");
    const quota = usageRowToQuota({
      row: detail,
      quotaType,
      capturedAtUnixMs
    });
    if (!quota) throw new ProbeFailure("parse_failed");
    quotas.push(quota);
  }
  return quotas;
}

function quotaTypeFromWindow(window) {
  if (!window) return null;
  const duration = finiteNumber(window.duration);
  const timeUnit = stringValue(window.timeUnit ?? window.time_unit);
  if (duration === null || duration <= 0 || !Number.isInteger(duration)) {
    return null;
  }
  if (timeUnit === "TIME_UNIT_MONTH") {
    return duration === 1 ? "monthly" : null;
  }
  const secondsPerUnit = {
    TIME_UNIT_SECOND: 1,
    TIME_UNIT_MINUTE: 60,
    TIME_UNIT_HOUR: 60 * 60,
    TIME_UNIT_DAY: 24 * 60 * 60,
    TIME_UNIT_WEEK: 7 * 24 * 60 * 60
  }[timeUnit];
  if (!secondsPerUnit) return null;
  const seconds = duration * secondsPerUnit;
  if (!Number.isSafeInteger(seconds)) return null;
  if (seconds === 5 * 60 * 60) return "session";
  if (seconds === 24 * 60 * 60) return "daily";
  if (seconds === 7 * 24 * 60 * 60) return "weekly";
  return null;
}

function usageRowToQuota(input) {
  if (!input.row) return null;
  const limit = finiteNumber(input.row.limit);
  const used = finiteNumber(input.row.used);
  const remaining = finiteNumber(input.row.remaining);
  if (limit === null || limit <= 0 || (used === null && remaining === null)) {
    return null;
  }
  if ((used !== null && used < 0) || (remaining !== null && remaining < 0)) {
    return null;
  }
  const remainingAmount = remaining ?? Math.max(0, limit - used);
  const percentRemaining = Math.max(
    0,
    Math.min(100, Math.round((remainingAmount / limit) * 10_000) / 100)
  );
  if (!Number.isFinite(percentRemaining)) return null;
  const resetsAtUnixMs = resetTimeFromRow(input.row, input.capturedAtUnixMs);
  return {
    quotaType: input.quotaType,
    percentRemaining,
    ...(resetsAtUnixMs === null ? {} : { resetsAtUnixMs }),
    ...(input.modelName ? { modelName: input.modelName } : {})
  };
}

function resetTimeFromRow(row, capturedAtUnixMs) {
  for (const key of ["reset_at", "resetAt", "reset_time", "resetTime"]) {
    const parsed = absoluteUnixMs(row[key]);
    if (parsed !== null) return parsed;
  }
  for (const key of ["reset_in", "resetIn", "ttl", "window"]) {
    const seconds = finiteNumber(row[key]);
    if (seconds !== null && seconds > 0) {
      const value = capturedAtUnixMs + Math.trunc(seconds * 1_000);
      return Number.isSafeInteger(value) ? value : null;
    }
  }
  return null;
}

function absoluteUnixMs(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
    return Number.isSafeInteger(Math.trunc(milliseconds))
      ? Math.trunc(milliseconds)
      : null;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function finiteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function recordValue(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeCapturedAt(value) {
  const normalized = Math.trunc(value);
  return Number.isSafeInteger(normalized) && normalized >= 0
    ? normalized
    : Date.now();
}

function stableErrorCode(error) {
  return error instanceof ProbeFailure && ERROR_CODES.has(error.code)
    ? error.code
    : "execution_failed";
}

async function readOptionalFile(filePath, readFile) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}
