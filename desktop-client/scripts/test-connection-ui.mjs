import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import electron from "electron";

const testDir = await mkdtemp(path.join(tmpdir(), "skylab-connection-test-"));
const env = { ...process.env, SKYLAB_CONNECTION_TEST_DIR: testDir };
delete env.ELECTRON_RUN_AS_NODE;
try {
  const child = spawn(electron, ["scripts/fixtures/connection-ui.cjs"], {
    env,
    stdio: "inherit",
    windowsHide: true
  });
  const timeout = setTimeout(() => child.kill(), 45_000);
  try {
    const [code] = await once(child, "exit");
    if (code !== 0)
      throw new Error(`Connection UI regression test exited ${code}`);
  } finally {
    clearTimeout(timeout);
  }
} finally {
  if (
    path.dirname(path.resolve(testDir)) !== path.resolve(tmpdir()) ||
    !path.basename(testDir).startsWith("skylab-connection-test-")
  ) {
    throw new Error("Unexpected test data directory");
  }
  await rm(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
