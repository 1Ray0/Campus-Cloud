import { shell } from "electron";
import { BusinessError, ResponseCode } from "../core/BusinessError";
import Logger from "../core/Logger";
import SkyLabService from "./SkyLabService";
import SettingsService from "./SettingsService";
import WireGuardTunnelService from "./WireGuardTunnelService";

class AuthService {
  private readonly _SkyLabService: SkyLabService;
  private readonly _settingsService: SettingsService;
  private readonly _tunnelService: WireGuardTunnelService;
  private _pollTimer: NodeJS.Timeout | null = null;
  private _loginInProgress = false;
  private _loginAttempt = 0;

  constructor(
    SkyLabService: SkyLabService,
    settingsService: SettingsService,
    tunnelService: WireGuardTunnelService
  ) {
    this._SkyLabService = SkyLabService;
    this._settingsService = settingsService;
    this._tunnelService = tunnelService;
  }

  private _tokenIsUsable(token: string): boolean {
    try {
      const parts = token.split(".");
      if (parts.length !== 3) return false;
      const payload = JSON.parse(
        Buffer.from(parts[1], "base64url").toString("utf-8")
      ) as { exp?: unknown };
      return (
        typeof payload.exp === "number" &&
        Number.isFinite(payload.exp) &&
        payload.exp > Math.floor(Date.now() / 1000) + 30
      );
    } catch {
      return false;
    }
  }

  async isLoggedIn(): Promise<boolean> {
    const token = await this._settingsService.getToken();
    if (token && this._tokenIsUsable(token)) return true;
    try {
      if (await this._SkyLabService.refreshSession()) return true;
    } catch (error) {
      Logger.warn("AuthService.isLoggedIn.refresh", (error as Error).message);
      // Preserve the rotating token during a temporary backend outage. API
      // calls can retry the refresh after connectivity returns.
      return !!(await this._settingsService.getRefreshToken());
    }
    await this._settingsService.clearTokens();
    return false;
  }

  isLoginInProgress(): boolean {
    return this._loginInProgress;
  }

  /**
   * Start device-code login. Opens the login URL in the user's browser,
   * then polls the backend until approved. Calls onResult when the flow
   * finishes (success or failure).
   */
  async startLogin(
    onResult: (success: boolean, error?: BusinessError) => void
  ): Promise<void> {
    if (this._loginInProgress) {
      return;
    }
    this._loginInProgress = true;
    const attempt = ++this._loginAttempt;
    const isCurrent = () =>
      this._loginInProgress && this._loginAttempt === attempt;
    const finish = (success: boolean, error?: BusinessError) => {
      if (!isCurrent()) return;
      this._loginInProgress = false;
      this._pollTimer = null;
      onResult(success, error);
    };

    try {
      const dc = await this._SkyLabService.requestDeviceCode();
      if (!isCurrent()) return;
      if (!dc.device_code) {
        throw new BusinessError(
          ResponseCode.INTERNAL_ERROR,
          "Backend returned an invalid device code"
        );
      }
      const loginUrl = new URL(
        "/login",
        await this._settingsService.getBackendUrl()
      );
      loginUrl.searchParams.set("device_code", dc.device_code);
      if (!isCurrent()) return;
      await shell.openExternal(loginUrl.toString());
      if (!isCurrent()) return;
      const expiresAt = Date.now() + dc.expires_in * 1000;

      const poll = async () => {
        if (!isCurrent()) return;
        if (Date.now() > expiresAt) {
          finish(false, new BusinessError(ResponseCode.LOGIN_TIMEOUT));
          return;
        }
        try {
          const result = await this._SkyLabService.pollDeviceCode(
            dc.device_code
          );
          if (!isCurrent()) return;
          if (result.status === "denied") {
            finish(false, new BusinessError(ResponseCode.LOGIN_CANCELLED));
            return;
          }
          if (result.status === "approved" && result.accessToken) {
            await this._settingsService.setTokens(
              result.accessToken,
              result.refreshToken || ""
            );
            finish(true);
            return;
          }
          this._pollTimer = setTimeout(poll, 2000);
        } catch (err) {
          if (!isCurrent()) return;
          Logger.warn("AuthService.startLogin.poll", (err as Error).message);
          finish(
            false,
            err instanceof BusinessError
              ? err
              : new BusinessError(
                  ResponseCode.INTERNAL_ERROR,
                  (err as Error).message
                )
          );
        }
      };

      this._pollTimer = setTimeout(poll, 2000);
    } catch (err) {
      if (!isCurrent()) return;
      this._loginInProgress = false;
      throw err;
    }
  }

  cancelLogin() {
    ++this._loginAttempt;
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    this._loginInProgress = false;
  }

  async logout(): Promise<void> {
    this.cancelLogin();
    const token = await this._settingsService.getToken();
    const refreshToken = await this._settingsService.getRefreshToken();
    if (token || refreshToken) {
      try {
        await this._tunnelService.stopTunnel();
      } catch (error) {
        Logger.error("AuthService.logout.stopTunnel", error as Error);
      }
      try {
        await this._SkyLabService.logout();
      } catch (error) {
        Logger.error("AuthService.logout.revokeToken", error as Error);
      }
    }
    await this._settingsService.clearTokens();
  }
}

export default AuthService;
