/**
 * Tests for the isLoggedIn helper exported from useAuth.
 *
 * Pure function — only checks localStorage for the access_token key.
 * Hook itself requires React context (router/query client) so we only
 * cover the pure helper here. Hook integration tests live elsewhere.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { isLoggedIn } from "./useAuth"

class MemoryStorage implements Storage {
  private store = new Map<string, string>()
  get length(): number {
    return this.store.size
  }
  clear(): void {
    this.store.clear()
  }
  getItem(key: string): string | null {
    return this.store.get(key) ?? null
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null
  }
  removeItem(key: string): void {
    this.store.delete(key)
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }
}

describe("isLoggedIn", () => {
  let storage: MemoryStorage

  beforeEach(() => {
    storage = new MemoryStorage()
    vi.stubGlobal("localStorage", storage)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("returns false when no access_token key exists", () => {
    expect(isLoggedIn()).toBe(false)
  })

  it("returns true when access_token is set to a non-empty string", () => {
    storage.setItem("access_token", "header.payload.signature")
    expect(isLoggedIn()).toBe(true)
  })

  it("returns true even for an empty string token (presence-only check)", () => {
    // Current implementation uses `getItem(...) !== null`, so empty string still counts as logged-in.
    // This pins the contract; if changed to truthy check, update both impl + test together.
    storage.setItem("access_token", "")
    expect(isLoggedIn()).toBe(true)
  })

  it("returns false after the token is removed", () => {
    storage.setItem("access_token", "abc")
    expect(isLoggedIn()).toBe(true)
    storage.removeItem("access_token")
    expect(isLoggedIn()).toBe(false)
  })
})
