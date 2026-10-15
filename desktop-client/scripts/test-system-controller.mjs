import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { build } from "esbuild";

const bundle = await build({
  stdin: {
    contents: `export {default as SystemController} from './electron/controller/SystemController';
export {default as BeanFactory} from './electron/core/BeanFactory';
export {BusinessError, ResponseCode} from './electron/core/BusinessError';`,
    resolveDir: ".",
    loader: "ts"
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  plugins: [
    {
      name: "controller-runtime",
      setup(builder) {
        builder.onResolve({ filter: /(^|\/)Logger$/ }, () => ({
          path: "Logger",
          namespace: "fake"
        }));
        builder.onResolve({ filter: /\/utils\/PathUtils$/ }, () => ({
          path: "PathUtils",
          namespace: "fake"
        }));
        builder.onLoad({ filter: /.*/, namespace: "fake" }, () => ({
          contents: "export default {info(){},error(){}};"
        }));
      }
    }
  ]
});
const { SystemController, BeanFactory, BusinessError, ResponseCode } =
  await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
  );
let calls;
beforeEach(() => {
  calls = [];
  BeanFactory.clear();
  BeanFactory.setBean("systemService", {
    openSsh: async (...args) => calls.push(args)
  });
});
function request(args) {
  const replies = [];
  return {
    args,
    channel: "test",
    event: { reply: (_channel, response) => replies.push(response) },
    replies
  };
}

test("SSH uses the API identity and ignores a renderer-supplied alias", async () => {
  const alias = "skylab-" + "a".repeat(64);
  BeanFactory.setBean("SkyLabService", {
    getSshHostAlias: async vmid => {
      assert.equal(vmid, 212);
      return alias;
    }
  });
  const req = request({
    vmid: 212,
    host: "192.168.60.109",
    port: 22,
    hostKeyAlias: "untrusted"
  });
  await new SystemController().openSsh(req);
  assert.deepEqual(calls, [[22, "root", "192.168.60.109", alias]]);
  assert.equal(req.replies[0].bizCode, "A1000");
});

test("denied resource lookup stops SSH before the terminal opens", async () => {
  BeanFactory.setBean("SkyLabService", {
    getSshHostAlias: async () => {
      throw new BusinessError(ResponseCode.NOT_LOGGED_IN);
    }
  });
  const req = request({ vmid: 212, host: "192.168.60.109", port: 22 });
  await new SystemController().openSsh(req);
  assert.equal(calls.length, 0);
  assert.equal(req.replies[0].bizCode, "B1001");
});

test("RDP service errors retain their actionable code through IPC", async () => {
  BeanFactory.setBean("systemService", {
    openRdp: async () => {
      throw new BusinessError(ResponseCode.RDP_REFUSED);
    }
  });
  const req = request({ host: "192.168.60.109", port: 3389 });
  new SystemController().openRdp(req);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(req.replies[0].bizCode, "B1019");
});
