import { afterEach, expect, test, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function downloadUrl(apiUrl, override = "") {
  vi.stubEnv("VITE_API_URL", apiUrl);
  vi.stubEnv("VITE_DESKTOP_CLIENT_DOWNLOAD_URL", override);
  return (await import("./desktopClient.js")).DESKTOP_CLIENT_DOWNLOAD_URL;
}

test("same-origin deployments use the backend download setting", async () => {
  expect(await downloadUrl("")).toBe("/api/v1/desktop-client/download");
});

test("split-origin deployments download through their configured API", async () => {
  expect(await downloadUrl("https://api.example.org/")).toBe(
    "https://api.example.org/api/v1/desktop-client/download",
  );
});

test("an explicit installer URL overrides the backend endpoint", async () => {
  const custom = "https://downloads.example.org/SkyLab-Connect-Setup.exe";
  expect(await downloadUrl("https://api.example.org", custom)).toBe(custom);
});

test.each([
  [{ userAgentData: { platform: "Windows", mobile: false } }, "windows"],
  [{ platform: "Win32", userAgent: "Windows NT 10.0" }, "windows"],
  [{ platform: "MacIntel", userAgent: "Macintosh", maxTouchPoints: 0 }, "macos"],
  [{ userAgentData: { platform: "macOS", mobile: false } }, "macos"],
  [{ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" }, "macos"],
  [{ platform: "MacIntel", userAgent: "Macintosh", maxTouchPoints: 5 }, null],
  [{ platform: "iPhone", userAgent: "iPhone" }, null],
  [{ userAgentData: { platform: "Android", mobile: true } }, null],
  [{ platform: "Linux armv8l", userAgent: "Android" }, null],
  [{ platform: "Linux x86_64", userAgent: "Linux" }, null],
  [{}, null],
])("detects desktop platforms without treating mobile devices as Macs (%j)", async (browser, expected) => {
  const { getDesktopClientPlatform } = await import("./desktopClient.js");
  expect(getDesktopClientPlatform(browser)).toBe(expected);
});

test("platform downloads use the configured API origin", async () => {
  await downloadUrl("https://api.example.org///");
  const { getDesktopClientDownloadUrl } = await import("./desktopClient.js");
  expect(getDesktopClientDownloadUrl("windows")).toBe(
    "https://api.example.org/api/v1/desktop-client/download?platform=windows",
  );
  expect(getDesktopClientDownloadUrl("macos")).toBe(
    "https://api.example.org/api/v1/desktop-client/download?platform=macos",
  );
});

test("Windows and macOS overrides stay separate and preserve signed URLs", async () => {
  const windows = "https://downloads.example.org/client.exe?signature=abc";
  const mac = "https://downloads.example.org/client.dmg?signature=def";
  vi.stubEnv("VITE_DESKTOP_CLIENT_MAC_DOWNLOAD_URL", mac);
  await downloadUrl("", windows);
  const { getDesktopClientDownloadUrl } = await import("./desktopClient.js");
  expect(getDesktopClientDownloadUrl("windows")).toBe(windows);
  expect(getDesktopClientDownloadUrl("macos")).toBe(mac);
});
