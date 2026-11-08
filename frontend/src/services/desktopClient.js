// Follow the platform's configured release URL unless this deployment opts out.
const apiOrigin = (import.meta.env.VITE_API_URL || "").replace(/\/+$/, "");

export const DESKTOP_CLIENT_DOWNLOAD_URL =
  import.meta.env.VITE_DESKTOP_CLIENT_DOWNLOAD_URL ||
  `${apiOrigin}/api/v1/desktop-client/download`;

export const DESKTOP_CLIENT_MAC_DOWNLOAD_URL =
  import.meta.env.VITE_DESKTOP_CLIENT_MAC_DOWNLOAD_URL ||
  `${apiOrigin}/api/v1/desktop-client/download?platform=macos`;

export function getDesktopClientPlatform(browser = globalThis.navigator) {
  if (!browser) return null;
  const userAgent = browser.userAgent || "";
  // iPadOS can identify itself as a Mac when requesting a desktop website.
  if (browser.userAgentData?.mobile || /Android|iPhone|iPad|iPod/i.test(userAgent)
    || (/Mac/i.test(browser.platform || "") && browser.maxTouchPoints > 1)) {
    return null;
  }
  const platform = browser.userAgentData?.platform || browser.platform || userAgent;
  if (/Win/i.test(platform)) return "windows";
  if (/Mac/i.test(platform)) return "macos";
  return null;
}

export function getDesktopClientDownloadUrl(platform) {
  if (platform === "macos") return DESKTOP_CLIENT_MAC_DOWNLOAD_URL;
  // Direct Windows overrides may contain signed query strings. Keep them intact.
  if (import.meta.env.VITE_DESKTOP_CLIENT_DOWNLOAD_URL) return DESKTOP_CLIENT_DOWNLOAD_URL;
  return `${DESKTOP_CLIENT_DOWNLOAD_URL}?platform=windows`;
}
