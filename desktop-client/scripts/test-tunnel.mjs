import assert from "node:assert/strict";
import { createServer } from "node:net";
import { after, test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";

const bundle = await build({
  stdin: {
    contents: [
      'export { default, elevatedCommand, elevatedExitError, windowsArgument } from "./electron/service/WireGuardTunnelService";',
      'export { default as SkyLabService } from "./electron/service/SkyLabService";',
      'export { default as PathUtils } from "./electron/utils/PathUtils";',
      'export { default as AuthService } from "./electron/service/AuthService";'
    ].join("\n"),
    resolveDir: process.cwd(),
    loader: "ts"
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  plugins: [
    {
      name: "fake-desktop-runtime",
      setup(builder) {
        builder.onResolve(
          { filter: /^(electron|.*\/core\/(BeanFactory|Logger))$/ },
          args => ({ path: args.path, namespace: "fake" })
        );
        builder.onLoad({ filter: /.*/, namespace: "fake" }, args => ({
          contents:
            args.path === "electron"
              ? `export const app = {getPath: () => globalThis.__tunnelTestDataDir},
net = {}, shell = {openExternal: async () => {}}, BrowserWindow = {}, Notification = class {},
safeStorage = {isEncryptionAvailable: () => true, encryptString: value => Buffer.from("enc:" + value), decryptString: value => value.toString().slice(4)};`
              : args.path.endsWith("BeanFactory")
                ? "export default {getBean: () => ({})};"
                : "export default {info(){},warn(){},error(){},debug(){}};"
        }));
      }
    }
  ]
});
const {
  default: Tunnel,
  elevatedCommand,
  elevatedExitError,
  windowsArgument,
  SkyLabService,
  PathUtils,
  AuthService
} = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);
const testDataDir = mkdtempSync(path.join(tmpdir(), "skylab-tunnel-test-"));
globalThis.__tunnelTestDataDir = testDataDir;
after(() => {
  assert.equal(path.dirname(path.resolve(testDataDir)), path.resolve(tmpdir()));
  assert.ok(path.basename(testDataDir).startsWith("skylab-tunnel-test-"));
  rmSync(testDataDir, { recursive: true, force: true });
});
const deferred = () => {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
};

test("repeated starts coalesce and stop waits for start", async () => {
  const tunnel = new Tunnel();
  const entered = deferred(),
    finish = deferred();
  const calls = [];
  tunnel._startTunnel = async () => {
    calls.push("start");
    entered.resolve();
    await finish.promise;
  };
  tunnel._stopTunnel = async () => {
    calls.push("stop");
  };
  const first = tunnel.startTunnel();
  const second = tunnel.startTunnel();
  await entered.promise;
  const stop = tunnel.stopTunnel();
  assert.deepEqual(calls, ["start"]);
  finish.resolve();
  await Promise.all([first, second, stop]);
  assert.deepEqual(calls, ["start", "stop"]);
});

test("status waits for startup instead of reporting an orphan", async () => {
  const tunnel = new Tunnel();
  const entered = deferred(),
    finish = deferred();
  tunnel.isRunning = async () => true;
  tunnel._readLatestHandshake = async () => ({ at: null, unavailable: true });
  tunnel._startTunnel = async () => {
    entered.resolve();
    await finish.promise;
    tunnel._lastStartTime = Date.now();
    tunnel._expiresAt = Date.now() + 60000;
  };
  const start = tunnel.startTunnel();
  await entered.promise;
  const status = tunnel.getStatus();
  finish.resolve();
  await start;
  assert.equal((await status).running, true);
  assert.equal((await status).connectionError, null);
});

test("a stop during handshake inspection discards the stale running snapshot", async () => {
  const tunnel = new Tunnel();
  const inspected = deferred(),
    finish = deferred();
  let running = true;
  tunnel._lastStartTime = Date.now();
  tunnel.isRunning = async () => running;
  tunnel._readLatestHandshake = async () => {
    inspected.resolve();
    await finish.promise;
    return 123;
  };
  tunnel._stopTunnel = async () => {
    running = false;
    tunnel._lastStartTime = -1;
  };
  const status = tunnel.getStatus();
  await inspected.promise;
  await tunnel.stopTunnel();
  finish.resolve();
  assert.equal((await status).running, false);
});

test("renewal failure warns while lease is valid; expiry still blocks", async () => {
  const tunnel = new Tunnel();
  tunnel._lastStartTime = Date.now();
  tunnel._expiresAt = Date.now() + 60000;
  tunnel.isRunning = async () => true;
  tunnel._readLatestHandshake = async () => ({ at: null, unavailable: true });
  tunnel._refreshTunnelLease = async () => {
    throw new Error("HTTP 502");
  };
  await tunnel.refreshIfRunning("test");
  const status = await tunnel.getStatus();
  assert.equal(status.running, true);
  assert.equal(status.connectionError, null);
  assert.equal(status.leaseRefreshError, "HTTP 502");
  tunnel._expiresAt = Date.now() - 1;
  const expired = await tunnel.getStatus();
  assert.equal(expired.running, false);
  assert.equal(expired.connectionErrorCode, "B1013");
});

test("a genuinely orphaned service still requires reconnecting", async () => {
  const tunnel = new Tunnel();
  tunnel.isRunning = async () => true;
  tunnel._readLatestHandshake = async () => ({ at: null, unavailable: true });
  const status = await tunnel.getStatus();
  assert.equal(status.running, false);
  assert.match(status.connectionError, /earlier app session/);
  assert.equal(status.connectionErrorCode, "B1014");
});

test("declining UAC is reported separately from a failed admin action", () => {
  assert.equal(elevatedExitError(0), null);
  assert.equal(elevatedExitError(1223).bizCode, "B1011");
  const failed = elevatedExitError(1603);
  assert.equal(failed.bizCode, "B1012");
  assert.match(failed.message, /exit code 1603/);
  assert.equal(elevatedExitError(null).bizCode, "B1012");
});

test("arguments with spaces or quotes follow Windows command-line quoting", () => {
  assert.equal(windowsArgument("/qn"), "/qn");
  assert.equal(
    windowsArgument(String.raw`C:\Program Files\SkyLab Connect\w.msi`),
    String.raw`"C:\Program Files\SkyLab Connect\w.msi"`
  );
  assert.equal(windowsArgument('say "hi"'), String.raw`"say \"hi\""`);
  assert.equal(
    windowsArgument("C:\\trailing dir\\"),
    String.raw`"C:\trailing dir\\"`
  );
  assert.equal(windowsArgument(""), '""');
});

test("elevated command runs as admin and maps the UAC cancel to exit 1223", () => {
  const command = elevatedCommand(
    String.raw`C:\Program Files\WireGuard\wireguard.exe`,
    ["/installtunnelservice", String.raw`C:\Users\O'Brien Lee\SkyLab.conf`]
  );
  assert.ok(
    command.includes(
      String.raw`$psi.FileName = 'C:\Program Files\WireGuard\wireguard.exe';`
    )
  );
  assert.ok(
    command.includes(
      String.raw`$psi.Arguments = '/installtunnelservice "C:\Users\O''Brien Lee\SkyLab.conf"';`
    )
  );
  assert.ok(command.includes("$psi.Verb = 'runas';"));
  assert.match(command, /NativeErrorCode -eq 1223\) \{ exit 1223 \}/);
  assert.match(command, /exit \$p\.ExitCode$/);
});

test("a changed network configuration asks for a reconnect with its own code", async () => {
  const tunnel = new Tunnel();
  tunnel._lastStartTime = Date.now();
  tunnel._expiresAt = Date.now() + 60_000;
  tunnel._activeConfigFingerprint = "before";
  tunnel.isRunning = async () => true;
  tunnel._readLatestHandshake = async () => ({ at: null, unavailable: true });
  tunnel._probeAuthorizedTargets = async () => false;
  tunnel._activeIdentity = { deviceId: "device-1" };
  tunnel._activeIdentityScope = "test-scope";
  tunnel._SkyLabService = {
    getConnectionScope: async () => "test-scope",
    refreshWireGuard: async () => ({})
  };
  tunnel._configFingerprint = () => "after";
  await assert.rejects(
    tunnel.refreshTunnel(),
    error => error.bizCode === "B1015"
  );
  const status = await tunnel.getStatus();
  assert.equal(status.connectionErrorCode, "B1015");
});

test("reachable authorized SSH target confirms the tunnel when wg inspection is denied", async () => {
  const tunnel = new Tunnel();
  tunnel._lastStartTime = Date.now();
  tunnel._expiresAt = Date.now() + 60_000;
  tunnel._connections = [
    { vmid: 106, service: "ssh", host: "192.168.60.106", port: 22 }
  ];
  tunnel.isRunning = async () => true;
  tunnel._readLatestHandshake = async () => ({ at: null, unavailable: true });
  tunnel._probeAuthorizedTargets = async () => true;

  const status = await tunnel.getStatus();
  assert.equal(status.running, true);
  assert.equal(status.connected, true);
  assert.equal(status.handshakeUnavailable, true);
  assert.equal(status.latestHandshakeAt, null);
});

test("unreadable handshake without reachable targets does not claim a connection", async () => {
  const tunnel = new Tunnel();
  tunnel._lastStartTime = Date.now();
  tunnel._expiresAt = Date.now() + 60_000;
  tunnel._connections = [
    { vmid: 106, service: "ssh", host: "192.168.60.106", port: 22 }
  ];
  tunnel.isRunning = async () => true;
  tunnel._readLatestHandshake = async () => ({ at: null, unavailable: true });
  tunnel._probeAuthorizedTargets = async () => false;

  const status = await tunnel.getStatus();
  assert.equal(status.running, true);
  assert.equal(status.connected, false);
  assert.equal(status.handshakeUnavailable, true);
});

test("authorized target probe detects an open TCP port", async () => {
  const server = createServer(socket => socket.end());
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const tunnel = new Tunnel();
    assert.equal(
      await tunnel._probeTarget({ host: "127.0.0.1", port: address.port }),
      true
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

const jwt = (sub, extra = {}) =>
  `header.${Buffer.from(JSON.stringify({ sub, ...extra })).toString("base64url")}.signature`;
const apiFor = (sub, backendUrl = "https://campus.example.org") =>
  new SkyLabService({
    getToken: async () => jwt(sub),
    getBackendUrl: async () => backendUrl
  });

test("connection identities are isolated by account and backend, and stable across token refresh", async () => {
  const accountA = await apiFor("account-a").getConnectionScope();
  const accountB = await apiFor("account-b").getConnectionScope();
  const otherBackend = await apiFor(
    "account-a",
    "https://other.example.org"
  ).getConnectionScope();
  assert.notEqual(accountA, accountB);
  assert.notEqual(accountA, otherBackend);
  const refreshedApi = apiFor("account-a", "https://campus.example.org/");
  refreshedApi._settingsService.getToken = async () =>
    jwt("account-a", { exp: 9999999999 });
  assert.equal(await refreshedApi.getConnectionScope(), accountA);
  const tunnel = new Tunnel();
  const legacyPath = PathUtils.getWireGuardIdentityFilePath();
  writeFileSync(legacyPath, "legacy-key-must-remain-untouched");
  const first = tunnel._loadIdentity(accountA);
  const second = tunnel._loadIdentity(accountB);
  assert.notEqual(first.publicKey, second.publicKey);
  assert.notEqual(first.deviceId, second.deviceId);
  assert.deepEqual(tunnel._loadIdentity(accountA), first);
  assert.equal(
    readFileSync(legacyPath, "utf8"),
    "legacy-key-must-remain-untouched"
  );
  assert.ok(
    !readFileSync(
      PathUtils.getWireGuardIdentityFilePath(accountA),
      "utf8"
    ).includes(first.privateKey)
  );
});

test("missing account identity cannot fall back to a shared key", async () => {
  await assert.rejects(
    apiFor(undefined).getConnectionScope(),
    error => error.bizCode === "B1001"
  );
  assert.throws(
    () => PathUtils.getWireGuardIdentityFilePath("../other-account"),
    /Invalid/
  );
});

test("switching accounts cannot reuse the running account's tunnel or key", async () => {
  const tunnel = new Tunnel();
  const scopeA = await apiFor("account-a").getConnectionScope();
  const scopeB = await apiFor("account-b").getConnectionScope();
  tunnel._activeIdentityScope = scopeA;
  tunnel._activeIdentity = tunnel._loadIdentity(scopeA);
  const oldPublicKey = tunnel._activeIdentity.publicKey;
  tunnel._lastStartTime = Date.now();
  tunnel._expiresAt = Date.now() + 60000;
  tunnel.isRunning = async () => true;
  const calls = [];
  let removed = false;
  tunnel._removeLocalTunnelService = async () => {
    removed = true;
  };
  tunnel._SkyLabService.disconnectWireGuard = async () => {};
  tunnel._ensureWireGuardInstalled = async () => {};
  tunnel._SkyLabService.getConnectionScope = async () => scopeB;
  tunnel._SkyLabService.connectWireGuard = async (deviceId, publicKey) => {
    assert.equal(removed, true);
    calls.push({ deviceId, publicKey });
    throw new Error("test stops before installing a service");
  };
  await assert.rejects(tunnel.startTunnel(), /test stops/);
  assert.deepEqual(calls, [
    {
      deviceId: tunnel._loadIdentity(scopeB).deviceId,
      publicKey: tunnel._loadIdentity(scopeB).publicKey
    }
  ]);
  assert.notEqual(calls[0].publicKey, oldPublicKey);
  assert.match(tunnel.connectionError, /test stops/);
});

test("renewal refuses to apply a different account's lease", async () => {
  const tunnel = new Tunnel();
  tunnel.isRunning = async () => true;
  tunnel._lastStartTime = Date.now();
  tunnel._activeIdentityScope = "old-account";
  tunnel._activeIdentity = { deviceId: "old-device" };
  let removed = false;
  tunnel._removeLocalTunnelService = async () => {
    removed = true;
  };
  tunnel._SkyLabService.disconnectWireGuard = async () => {};
  tunnel._SkyLabService.getConnectionScope = async () => "new-account";
  tunnel._SkyLabService.refreshWireGuard = async () =>
    assert.fail("must not renew another account's device");
  await assert.rejects(tunnel.refreshTunnel(), /signed-in account changed/);
  assert.equal(removed, true);
  assert.equal(tunnel._activeIdentity, null);
});

test("logout disconnects the active profile and clears its in-memory identity", async () => {
  const tunnel = new Tunnel();
  const devices = [];
  tunnel._activeIdentity = { deviceId: "active-device" };
  tunnel._activeIdentityScope = "active-account";
  tunnel._removeLocalTunnelService = async () => {};
  tunnel._SkyLabService.disconnectWireGuard = async device =>
    devices.push(device);
  await tunnel.stopTunnel();
  assert.deepEqual(devices, ["active-device"]);
  assert.equal(tunnel._activeIdentity, null);
  assert.equal(tunnel._activeIdentityScope, null);
});

test("Web account switch followed by desktop logout and sign-in uses the new account's own device", async t => {
  let token = jwt("flow-account-a");
  let refreshToken = "refresh-a";
  const settings = {
    getToken: async () => token,
    getRefreshToken: async () => refreshToken,
    getBackendUrl: async () => "https://campus.example.org",
    setTokens: async (access, refresh) => {
      token = access;
      refreshToken = refresh;
    },
    clearTokens: async () => {
      token = "";
      refreshToken = "";
    }
  };
  const subject = () =>
    JSON.parse(Buffer.from(token.split(".")[1], "base64url")).sub;
  const api = new SkyLabService(settings);
  const connected = [];
  const disconnected = [];
  let revokedUser;
  api.connectWireGuard = async (deviceId, publicKey) => {
    connected.push({ user: subject(), deviceId, publicKey });
    return { connections: [], expires_in: 3600 };
  };
  api.disconnectWireGuard = async deviceId =>
    disconnected.push({ user: subject(), deviceId });
  api.logout = async () => {
    revokedUser = subject();
  };
  const tunnel = new Tunnel();
  tunnel._SkyLabService = api;
  tunnel._ensureWireGuardInstalled = async () => {};
  tunnel._removeLocalTunnelService = async () => {};
  tunnel._runElevatedWireGuard = async () => {};
  tunnel._waitUntilRunning = async () => true;
  tunnel._readLatestHandshake = async () => ({ at: null, unavailable: true });
  tunnel._buildConfig = () => "[Interface]";
  tunnel.isRunning = async () => true;
  await tunnel.startTunnel();

  // Only the browser changed to B; the desktop must revoke A before clearing A.
  const auth = new AuthService(api, settings, tunnel);
  await auth.logout();
  assert.equal(revokedUser, "flow-account-a");
  assert.deepEqual(disconnected, [
    { user: "flow-account-a", deviceId: connected[0].deviceId }
  ]);
  assert.equal(token, "");
  assert.equal((await tunnel.getStatus()).running, false);

  api.requestDeviceCode = async () => ({
    device_code: "flow-code",
    login_url: "https://campus.example.org/login",
    expires_in: 300
  });
  api.pollDeviceCode = async () => ({
    status: "approved",
    accessToken: jwt("flow-account-b"),
    refreshToken: "refresh-b"
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let complete;
  const authenticated = new Promise(resolve => {
    complete = resolve;
  });
  await auth.startLogin(success => complete(success));
  t.mock.timers.tick(2000);
  assert.equal(await authenticated, true);
  t.mock.timers.reset();
  await tunnel.startTunnel();
  assert.equal(connected[1].user, "flow-account-b");
  assert.notEqual(connected[0].deviceId, connected[1].deviceId);
  assert.notEqual(connected[0].publicKey, connected[1].publicKey);
  assert.equal((await tunnel.getStatus()).running, true);
});
