import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

test("published CLI runs as a standalone script through a fixed Node interpreter", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "kimi-usage-cli-"));
  try {
    const snapshot = path.join(temporaryRoot, "runtime");
    await copyFile(path.join(packageRoot, "dist", "cli.cjs"), snapshot);
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [snapshot, "--output", "json"],
      {
        env: { ...process.env, KIMI_MODEL_NAME: "snapshot-api-model" }
      }
    );
    assert.equal(stderr, "");
    const result = JSON.parse(stdout);
    assert.equal(result.schemaVersion, "tutti.agent.account-usage.v1");
    assert.equal(result.outcome, "available");
    assert.equal(result.billingMode, "api");
    assert.deepEqual(result.quotas, []);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
