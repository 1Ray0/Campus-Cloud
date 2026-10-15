import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { build } from "esbuild";
import { createServer } from "node:net";
import { once } from "node:events";

globalThis.__systemTest = { calls: [], automatic: true, exitCode: 0 };
const bundle = await build({
  entryPoints: ["electron/service/SystemService.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  plugins: [
    {
      name: "terminal-runtime",
      setup(builder) {
        builder.onResolve({ filter: /^(child_process|electron)$/ }, args => ({
          path: args.path,
          namespace: "fake"
        }));
        builder.onLoad({ filter: /.*/, namespace: "fake" }, ({ path }) => ({
          contents:
            path === "electron"
              ? "export const app = {}, shell = {};"
              : `import {EventEmitter} from 'node:events';
         export const spawn = (command, args, options) => {
           const child = new EventEmitter(); child.unref = () => {};
           globalThis.__systemTest.calls.push({command, args, options, child});
           if(globalThis.__systemTest.automatic) queueMicrotask(() => {child.emit('spawn'); child.emit('exit',globalThis.__systemTest.exitCode);});
           return child;
         };`
        }));
      }
    }
  ]
});
const { default: SystemService } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);
let service;
beforeEach(() => {
  globalThis.__systemTest = { calls: [], automatic: true, exitCode: 0 };
  service = new SystemService();
});

test(
  "SSH opens a visible independent console with an interactive CMD that stays open",
  { skip: process.platform !== "win32" },
  async () => {
    await service.openSsh(2222, "root", "10.10.0.15");
    const launch = globalThis.__systemTest.calls[0];
    assert.equal(launch.command, "powershell.exe");
    assert.equal(launch.options.windowsHide, true);
    assert.equal(launch.options.detached, undefined);
    const script = launch.args.at(-1);
    assert.match(script, /Start-Process -FilePath \$env:ComSpec/);
    assert.match(script, /-WindowStyle Normal/);
    assert.match(script, /\/d \/k/);
    assert.match(
      script,
      /ssh -o StrictHostKeyChecking=accept-new -p 2222 root@10\.10\.0\.15/
    );
  }
);

test(
  "the launcher reports success only after Start-Process completes",
  { skip: process.platform !== "win32" },
  async () => {
    globalThis.__systemTest.automatic = false;
    let complete = false;
    const pending = service.openSsh(22).then(() => {
      complete = true;
    });
    globalThis.__systemTest.calls[0].child.emit("spawn");
    await Promise.resolve();
    assert.equal(complete, false);
    globalThis.__systemTest.calls[0].child.emit("exit", 0);
    await pending;
  }
);

test(
  "a failed terminal launcher reaches the app error handler",
  { skip: process.platform !== "win32" },
  async () => {
    globalThis.__systemTest.exitCode = 1;
    await assert.rejects(service.openSsh(22), /launcher exited 1/);
    globalThis.__systemTest.automatic = false;
    const pending = service.openSsh(22);
    globalThis.__systemTest.calls
      .at(-1)
      .child.emit("error", new Error("PowerShell unavailable"));
    await assert.rejects(pending, /PowerShell unavailable/);
  }
);

test("invalid SSH targets cannot reach a command interpreter", async () => {
  for (const args of [
    [0],
    [65536],
    [22, "root & whoami"],
    [22, "root", "127.0.0.1 & whoami"],
    [22, "root", "127.0.0.1", "skylab-abc & whoami"]
  ]) {
    await assert.rejects(service.openSsh(...args), /Invalid SSH target/);
  }
  assert.equal(globalThis.__systemTest.calls.length, 0);
});

test(
  "resource aliases retain strict key checks without colliding with reused IP records",
  { skip: process.platform !== "win32" },
  async () => {
    const alias = "skylab-" + "a".repeat(64);
    await service.openSsh(22, "root", "192.168.60.109", alias);
    const script = globalThis.__systemTest.calls[0].args.at(-1);
    assert.match(script, /StrictHostKeyChecking=accept-new/);
    assert.ok(script.includes(`HostKeyAlias=${alias} -o CheckHostIP=no`));
    assert.doesNotMatch(
      script,
      /StrictHostKeyChecking=no|UserKnownHostsFile|ssh-keygen/
    );
  }
);

test(
  "RDP reaches a listening endpoint before starting the client",
  { skip: process.platform !== "win32" },
  async () => {
    const server = createServer(socket => socket.end());
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;
    try {
      await service.openRdp(port);
      assert.equal(globalThis.__systemTest.calls[0].command, "mstsc.exe");
      assert.deepEqual(globalThis.__systemTest.calls[0].args, [
        `/v:127.0.0.1:${port}`
      ]);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  }
);

test("an unavailable RDP service gives a specific error without launching a doomed client", async () => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  await assert.rejects(
    service.openRdp(port),
    error => error.bizCode === "B1019"
  );
  assert.equal(globalThis.__systemTest.calls.length, 0);
});

test("invalid RDP destinations cannot reach the network or launcher", async () => {
  for (const args of [[0], [65536], [3389, "127.0.0.1 & whoami"]]) {
    await assert.rejects(service.openRdp(...args), /Invalid RDP target/);
  }
  assert.equal(globalThis.__systemTest.calls.length, 0);
});
