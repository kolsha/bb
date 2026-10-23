import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnvironmentReadCache } from "./reads.js";

const TARGET = { environmentId: "env_1", hostId: "host_1" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("EnvironmentReadCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shares one in-flight load and reuses the value until it expires", async () => {
    const cache = new EnvironmentReadCache<number>(3_000);
    const load = vi.fn(async () => 1);
    await Promise.all([
      cache.read(TARGET, "k", "shared", load),
      cache.read(TARGET, "k", "shared", load),
    ]);
    await cache.read(TARGET, "k", "shared", load);
    expect(load).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3_000);
    await cache.read(TARGET, "k", "shared", load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("only shares in-flight loads when the TTL is zero", async () => {
    const cache = new EnvironmentReadCache<number>(0);
    const pending = deferred<number>();
    const load = vi.fn(() => pending.promise);
    const first = cache.read(TARGET, "k", "shared", load);
    const second = cache.read(TARGET, "k", "shared", load);
    pending.resolve(1);
    await Promise.all([first, second]);
    expect(load).toHaveBeenCalledTimes(1);
    await cache.read(TARGET, "k", "shared", async () => 2);
    expect(await cache.read(TARGET, "k", "shared", async () => 3)).toBe(3);
  });

  it("drops finished values it does not retain", async () => {
    const cache = new EnvironmentReadCache<number>(3_000, (value) => value > 0);
    await cache.read(TARGET, "k", "shared", async () => 0);
    expect(await cache.read(TARGET, "k", "shared", async () => 2)).toBe(2);
    expect(await cache.read(TARGET, "k", "shared", async () => 3)).toBe(2);
  });

  it("does not keep failed loads", async () => {
    const cache = new EnvironmentReadCache<number>(3_000);
    await expect(
      cache.read(TARGET, "k", "shared", async () => {
        throw new Error("git failed");
      }),
    ).rejects.toThrow("git failed");
    expect(await cache.read(TARGET, "k", "shared", async () => 2)).toBe(2);
  });

  it("starts a fresh load after the environment is cleared mid-flight", async () => {
    const cache = new EnvironmentReadCache<number>(3_000);
    const stale = deferred<number>();
    const first = cache.read(TARGET, "k", "shared", () => stale.promise);
    cache.clear("env_1");
    const fresh = cache.read(TARGET, "k", "shared", async () => 2);
    stale.resolve(1);
    expect(await first).toBe(1);
    expect(await fresh).toBe(2);
    expect(await cache.read(TARGET, "k", "shared", async () => 3)).toBe(2);
  });

  it("clears every entry on a host", async () => {
    const cache = new EnvironmentReadCache<number>(3_000);
    await cache.read(TARGET, "a", "shared", async () => 1);
    await cache.read({ environmentId: "env_2", hostId: "host_1" }, "b", "shared", async () => 1);
    await cache.read({ environmentId: "env_3", hostId: "host_2" }, "c", "shared", async () => 1);
    cache.clearHost("host_1");
    expect(await cache.read(TARGET, "a", "shared", async () => 2)).toBe(2);
    expect(
      await cache.read({ environmentId: "env_3", hostId: "host_2" }, "c", "shared", async () => 2),
    ).toBe(1);
  });
});
