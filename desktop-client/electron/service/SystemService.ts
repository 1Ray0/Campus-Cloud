import { spawn } from "child_process";
import { app, shell } from "electron";
import { createConnection, isIP } from "net";
import { BusinessError, ResponseCode } from "../core/BusinessError";

class SystemService {
  /**
   * 只開允許的網址：固定的 GitHub／SkyLab 網域，加上設定頁填的後端網址
   * （「開啟 Web 平台」用它；可能是自架網域或本機測試的 http://localhost）
   */
  async openUrl(url: string, backendUrl?: string) {
    const target = new URL(url);
    const allowedHosts = new Set([
      "github.com",
      "objects.githubusercontent.com",
      "github-releases.githubusercontent.com",
      "skylab-tw.com"
    ]);
    const isBackend =
      !!backendUrl && target.origin === new URL(backendUrl).origin;
    if (
      !isBackend &&
      (target.protocol !== "https:" || !allowedHosts.has(target.hostname))
    ) {
      throw new Error(`URL is not allowed: ${target.origin}`);
    }
    await shell.openExternal(target.toString());
  }

  async relaunch() {
    app.relaunch();
    app.quit();
  }

  openLocalFile(filePath: string): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      shell
        .openPath(filePath)
        .then(errorMessage => {
          resolve(!errorMessage);
        })
        .catch(reject);
    });
  }

  openLocalPath(localPath: string): Promise<boolean> {
    return new Promise<boolean>(resolve => {
      shell.openPath(localPath).then(errorMessage => {
        resolve(!errorMessage);
      });
    });
  }

  async openSsh(
    port: number,
    user = "root",
    host = "127.0.0.1",
    hostKeyAlias?: string
  ): Promise<void> {
    if (
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      isIP(host) !== 4 ||
      !/^[a-z_][a-z0-9_-]*[$]?$/i.test(user) ||
      (hostKeyAlias !== undefined &&
        !/^skylab-[a-f0-9]{64}$/.test(hostKeyAlias))
    ) {
      throw new Error("Invalid SSH target");
    }
    const identityOptions = hostKeyAlias
      ? ` -o HostKeyAlias=${hostKeyAlias} -o CheckHostIP=no`
      : "";
    const sshCmd = `ssh -o StrictHostKeyChecking=accept-new${identityOptions} -p ${port} ${user}@${host}`;
    if (process.platform === "win32") {
      // Start-Process gives CMD its own console and input handle. A detached
      // CMD with stdio:ignore reads EOF and closes before it can be used.
      const argumentsText = `/d /k "title SkyLab SSH - ${host}:${port} & ${sshCmd}"`;
      const script = `$ErrorActionPreference = 'Stop'; Start-Process -FilePath $env:ComSpec -ArgumentList '${argumentsText}' -WindowStyle Normal`;
      await this._runTerminalLauncher("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script
      ]);
    } else if (process.platform === "darwin") {
      const script = `tell application "Terminal" to do script "${sshCmd}"`;
      spawn("osascript", ["-e", script], {
        detached: true,
        stdio: "ignore"
      }).unref();
    } else {
      spawn("x-terminal-emulator", ["-e", "sh", "-c", sshCmd], {
        detached: true,
        stdio: "ignore"
      }).unref();
    }
  }

  private _runTerminalLauncher(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        windowsHide: true,
        stdio: "ignore"
      });
      child.once("error", reject);
      child.once("exit", code => {
        if (code === 0) resolve();
        else reject(new Error(`SSH terminal launcher exited ${code}`));
      });
    });
  }

  async openRdp(port: number, host = "127.0.0.1"): Promise<void> {
    if (
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      isIP(host) !== 4
    ) {
      throw new Error("Invalid RDP target");
    }
    const target = `${host}:${port}`;
    if (process.platform === "win32") {
      // Let the native client handle connection retries and RDP diagnostics.
      // A short TCP probe can time out while the VPN route is becoming ready
      // and would prevent mstsc from opening at all.
      await this._spawnDetached("mstsc.exe", [`/v:${target}`]);
      return;
    }
    await this._checkRdpAvailability(host, port);
    if (process.platform === "darwin") {
      await shell.openExternal(`rdp://full%20address=s:${target}`);
      return;
    }
    await this._spawnDetached("xfreerdp", [`/v:${target}`]);
  }

  private _checkRdpAvailability(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host, port });
      const finish = (error?: Error) => {
        socket.removeAllListeners();
        socket.destroy();
        if (error) reject(error);
        else resolve();
      };
      socket.setTimeout(5000);
      socket.once("connect", () => finish());
      socket.once("timeout", () =>
        finish(new BusinessError(ResponseCode.RDP_UNREACHABLE))
      );
      socket.once("error", (error: NodeJS.ErrnoException) =>
        finish(
          new BusinessError(
            error.code === "ECONNREFUSED"
              ? ResponseCode.RDP_REFUSED
              : ResponseCode.RDP_UNREACHABLE,
            error.message
          )
        )
      );
    });
  }

  private _spawnDetached(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: false
      });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  }
}

export default SystemService;
