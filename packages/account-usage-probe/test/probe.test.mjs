import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ACCOUNT_USAGE_SCHEMA_VERSION,
  probeKimiAccountUsage
} from "../src/probe.mjs";

const capturedAtUnixMs = 1_770_000_000_000;
const testRoot = path.resolve(tmpdir(), "tutti-kimi-account-usage-probe-tests");
const kimiHome = path.join(testRoot, "kimi");
const configPath = path.join(kimiHome, "config.toml");
const credentialPath = path.join(kimiHome, "credentials", "kimi-code.json");
const homeDirectory = path.join(testRoot, "home");
const defaultHome = path.join(homeDirectory, ".kimi-code");
const defaultConfigPath = path.join(defaultHome, "config.toml");
const defaultCredentialPath = path.join(
  defaultHome,
  "credentials",
  "kimi-code.json"
);

test("API billing returns an explicit empty quota result without reading OAuth credentials", async () => {
  const reads = [];
  const result = await probeKimiAccountUsage({
    env: { KIMI_MODEL_NAME: "custom-model" },
    now: () => capturedAtUnixMs,
    readFile: async (filePath) => {
      reads.push(filePath);
      throw new Error("unexpected read");
    },
    fetch: async () => {
      throw new Error("unexpected fetch");
    }
  });

  assert.deepEqual(result, {
    schemaVersion: ACCOUNT_USAGE_SCHEMA_VERSION,
    outcome: "available",
    capturedAtUnixMs,
    billingMode: "api",
    quotas: []
  });
  assert.deepEqual(reads, []);
});

test("default configuration root remains ~/.kimi-code", async () => {
  const reads = [];
  const result = await probeKimiAccountUsage({
    env: {},
    homeDirectory: () => homeDirectory,
    now: () => capturedAtUnixMs,
    readFile: mapReader(
      new Map([
        [defaultConfigPath, managedConfig()],
        [defaultCredentialPath, credentials("secret-token")]
      ]),
      reads
    ),
    fetch: async () =>
      new Response(JSON.stringify({ usage: { limit: 10, used: 2 } }), {
        status: 200
      })
  });

  assert.equal(result.outcome, "available");
  assert.deepEqual(reads, [
    defaultConfigPath,
    defaultCredentialPath
  ]);
});

for (const [name, baseUrl] of [
  ["non-HTTPS", "http://api.kimi.com/coding/v1"],
  ["untrusted host", "https://usage.invalid/coding/v1"],
  ["untrusted path", "https://api.kimi.com/other"]
]) {
  test(`${name} managed endpoint is rejected before credentials or fetch are used`, async () => {
    const reads = [];
    let fetchCalls = 0;
    const files = new Map([
      [configPath, managedConfig({ baseUrl })],
      [credentialPath, credentials("secret-token")]
    ]);
    const result = await probeKimiAccountUsage({
      env: { KIMI_CODE_HOME: kimiHome },
      now: () => capturedAtUnixMs,
      readFile: mapReader(files, reads),
      fetch: async () => {
        fetchCalls += 1;
        throw new Error("unexpected fetch");
      }
    });

    assert.equal(result.errorCode, "config_invalid");
    assert.equal(result.outcome, "error");
    assert.deepEqual(reads, [configPath]);
    assert.equal(fetchCalls, 0);
    assert.doesNotMatch(JSON.stringify(result), /secret-token|usage\.invalid/);
  });
}

test("untrusted environment origin is rejected before fallback credentials are read", async () => {
  const reads = [];
  const result = await probeKimiAccountUsage({
    env: {
      KIMI_CODE_HOME: kimiHome,
      KIMI_CODE_BASE_URL: "http://api.kimi.com/coding/v1"
    },
    now: () => capturedAtUnixMs,
    readFile: async (filePath) => {
      reads.push(filePath);
      if (filePath.endsWith("config.toml")) {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      return credentials("secret-token");
    },
    fetch: async () => {
      throw new Error("unexpected fetch");
    }
  });

  assert.equal(result.errorCode, "config_invalid");
  assert.deepEqual(reads, [configPath]);
});

test("OAuth issuer, credential key, and usage endpoint must use the trusted Kimi binding", async () => {
  for (const override of [
    { oauthHost: "https://login.invalid" },
    { oauthKey: "oauth/other" },
    { oauthStorage: "keyring" }
  ]) {
    const reads = [];
    const result = await probeKimiAccountUsage({
      env: { KIMI_CODE_HOME: kimiHome },
      now: () => capturedAtUnixMs,
      readFile: mapReader(
        new Map([
          [configPath, managedConfig(override)],
          [credentialPath, credentials("secret-token")]
        ]),
        reads
      ),
      fetch: async () => {
        throw new Error("unexpected fetch");
      }
    });
    assert.equal(result.errorCode, "config_invalid");
    assert.deepEqual(reads, [configPath]);
  }
});

test("OAuth issuer environment overrides are rejected before reading credentials", async () => {
  for (const issuerVariable of ["KIMI_CODE_OAUTH_HOST", "KIMI_OAUTH_HOST"]) {
    const reads = [];
    let fetchCalls = 0;
    const result = await probeKimiAccountUsage({
      env: {
        KIMI_CODE_HOME: kimiHome,
        [issuerVariable]: "https://login.invalid"
      },
      now: () => capturedAtUnixMs,
      readFile: mapReader(
        new Map([
          [configPath, managedConfig()],
          [credentialPath, credentials("secret-token")]
        ]),
        reads
      ),
      fetch: async () => {
        fetchCalls += 1;
        throw new Error("unexpected fetch");
      }
    });

    assert.equal(result.errorCode, "config_invalid");
    assert.deepEqual(reads, [configPath]);
    assert.equal(fetchCalls, 0);
  }
});

test("trusted managed account sends a request-local token and returns strict normalized quotas", async () => {
  const requests = [];
  const files = new Map([
    [configPath, managedConfig()],
    [credentialPath, credentials("secret-token")]
  ]);
  const result = await probeKimiAccountUsage({
    env: { KIMI_CODE_HOME: kimiHome },
    now: () => capturedAtUnixMs,
    readFile: mapReader(files),
    fetch: async (url, init) => {
      requests.push({ url, init });
      return new Response(
        await readFile(
          new URL("../testdata/kimi-0.34.0-usages.json", import.meta.url),
          "utf8"
        ),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
  });

  const golden = JSON.parse(
    await readFile(new URL("../testdata/available.json", import.meta.url), "utf8")
  );
  assert.deepEqual(result, golden);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.kimi.com/coding/v1/usages");
  assert.equal(requests[0].init.headers.Authorization, "Bearer secret-token");
  assert.equal(requests[0].init.redirect, "error");
  assert.doesNotMatch(JSON.stringify(result), /secret-token/);
});

for (const [window, expectedQuotaType] of [
  [{ duration: 5, timeUnit: "TIME_UNIT_HOUR" }, "session"],
  [{ duration: 24, timeUnit: "TIME_UNIT_HOUR" }, "daily"],
  [{ duration: 7, timeUnit: "TIME_UNIT_DAY" }, "weekly"],
  [{ duration: 1, timeUnit: "TIME_UNIT_MONTH" }, "monthly"]
]) {
  test(`maps ${JSON.stringify(window)} to ${expectedQuotaType}`, async () => {
    const result = await probeKimiAccountUsage({
      env: { KIMI_CODE_HOME: kimiHome },
      now: () => capturedAtUnixMs,
      readFile: mapReader(
        new Map([
          [configPath, managedConfig()],
          [credentialPath, credentials("secret-token")]
        ])
      ),
      fetch: async () =>
        new Response(
          JSON.stringify({
            usage: { limit: 10, used: 2 },
            limits: [{ window, detail: { limit: 10, remaining: 4 } }]
          }),
          { status: 200 }
        )
    });

    assert.equal(result.outcome, "available");
    assert.equal(result.quotas[1].quotaType, expectedQuotaType);
  });
}

test("an unrepresentable usage window fails closed instead of becoming a model quota", async () => {
  const result = await probeKimiAccountUsage({
    env: { KIMI_CODE_HOME: kimiHome },
    now: () => capturedAtUnixMs,
    readFile: mapReader(
      new Map([
        [configPath, managedConfig()],
        [credentialPath, credentials("secret-token")]
      ])
    ),
    fetch: async () =>
      new Response(
        JSON.stringify({
          usage: { limit: 10, used: 2 },
          limits: [
            {
              window: { duration: 90, timeUnit: "TIME_UNIT_MINUTE" },
              detail: { limit: 10, remaining: 4 }
            }
          ]
        }),
        { status: 200 }
      )
  });

  assert.equal(result.outcome, "error");
  assert.equal(result.errorCode, "parse_failed");
});

test("401 rereads credentials once and retries only when the token changed", async () => {
  let credentialReads = 0;
  const requests = [];
  const result = await probeKimiAccountUsage({
    env: { KIMI_CODE_HOME: kimiHome },
    now: () => capturedAtUnixMs,
    readFile: async (filePath) => {
      if (filePath.endsWith("config.toml")) return managedConfig();
      credentialReads += 1;
      return credentials(credentialReads === 1 ? "first-token" : "second-token");
    },
    fetch: async (_url, init) => {
      requests.push(init.headers.Authorization);
      if (requests.length === 1) return new Response("unauthorized", { status: 401 });
      return new Response(JSON.stringify({ usage: { limit: 10, used: 2 } }), {
        status: 200
      });
    }
  });

  assert.equal(result.outcome, "available");
  assert.equal(credentialReads, 2);
  assert.deepEqual(requests, ["Bearer first-token", "Bearer second-token"]);
});

test("401 with an unchanged token fails closed without a second request", async () => {
  let fetchCalls = 0;
  const result = await probeKimiAccountUsage({
    env: { KIMI_CODE_HOME: kimiHome },
    now: () => capturedAtUnixMs,
    readFile: async (filePath) =>
      filePath.endsWith("config.toml")
        ? managedConfig()
        : credentials("unchanged-token"),
    fetch: async () => {
      fetchCalls += 1;
      return new Response("unauthorized", { status: 401 });
    }
  });

  assert.equal(result.errorCode, "session_expired");
  assert.equal(fetchCalls, 1);
});

for (const [name, response] of [
  ["unknown successful payload", new Response(JSON.stringify({ future: true }), { status: 200 })],
  ["invalid JSON", new Response("token=in-body", { status: 200 })]
]) {
  test(`${name} is parse_failed and does not expose raw payload`, async () => {
    const result = await probeKimiAccountUsage({
      env: { KIMI_CODE_HOME: kimiHome },
      now: () => capturedAtUnixMs,
      readFile: async (filePath) =>
        filePath.endsWith("config.toml")
          ? managedConfig()
          : credentials("secret-token"),
      fetch: async () => response.clone()
    });

    assert.deepEqual(result, {
      schemaVersion: ACCOUNT_USAGE_SCHEMA_VERSION,
      outcome: "error",
      capturedAtUnixMs,
      errorCode: "parse_failed"
    });
    assert.doesNotMatch(
      JSON.stringify(result),
      new RegExp(`future|token=in-body|secret-token|${escapeRegExp(kimiHome)}`)
    );
  });
}

test("oversized successful payload is parse_failed without unbounded buffering", async () => {
  const result = await probeKimiAccountUsage({
    env: { KIMI_CODE_HOME: kimiHome },
    now: () => capturedAtUnixMs,
    readFile: async (filePath) =>
      filePath.endsWith("config.toml")
        ? managedConfig()
        : credentials("secret-token"),
    fetch: async () =>
      new Response("x".repeat((1 << 20) + 1), { status: 200 })
  });

  assert.equal(result.errorCode, "parse_failed");
});

test("provider, filesystem, and network failures expose only stable error codes", async () => {
  const secrets = [
    "bearer-secret",
    "https://malicious.invalid/private",
    credentialPath,
    "raw-provider-body"
  ];
  const result = await probeKimiAccountUsage({
    env: { KIMI_CODE_HOME: kimiHome },
    now: () => capturedAtUnixMs,
    readFile: async (filePath) => {
      if (filePath.endsWith("config.toml")) return managedConfig();
      return credentials("bearer-secret");
    },
    fetch: async () => {
      throw new Error(secrets.join(" "));
    }
  });

  assert.equal(result.errorCode, "execution_failed");
  const serialized = JSON.stringify(result);
  for (const secret of secrets) assert.equal(serialized.includes(secret), false);
});

function managedConfig({
  baseUrl = "https://api.kimi.com/coding/v1",
  oauthHost = "https://auth.kimi.com",
  oauthKey = "oauth/kimi-code",
  oauthStorage = "file"
} = {}) {
  return [
    'default_model = "kimi-code/kimi-for-coding"',
    "",
    '[models."kimi-code/kimi-for-coding"]',
    'provider = "managed:kimi-code"',
    "",
    '[providers."managed:kimi-code"]',
    `base_url = ${JSON.stringify(baseUrl)}`,
    "",
    '[providers."managed:kimi-code".oauth]',
    `storage = ${JSON.stringify(oauthStorage)}`,
    `key = ${JSON.stringify(oauthKey)}`,
    `oauth_host = ${JSON.stringify(oauthHost)}`,
    ""
  ].join("\n");
}

function credentials(accessToken) {
  return JSON.stringify({ access_token: accessToken });
}

function mapReader(files, reads = []) {
  return async (filePath) => {
    reads.push(filePath);
    if (files.has(filePath)) return files.get(filePath);
    throw Object.assign(new Error(`missing ${filePath}`), { code: "ENOENT" });
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
