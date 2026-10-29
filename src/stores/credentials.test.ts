import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useCredentialsStore, isValidEnvKey } from "@/stores/credentials";

/** In-memory stand-in for the keychain pool store (credentials.rs). */
const credStore = vi.hoisted(() => ({
  map: new Map<string, string>(),
  failWrites: false,
}));

const storeApi = vi.hoisted(() => ({
  seed: new Map<string, unknown>(),
  values: new Map<string, unknown>(),
}));

vi.mock("@/lib/tauri", () => ({
  api: {
    credentialSetValues: vi.fn(async (id: string, values: string[]) => {
      if (credStore.failWrites) throw new Error("keychain locked");
      for (let i = 0; i < values.length; i++) credStore.map.set(`cred:${id}:${i}`, values[i]);
      // Drop stale tail entries, mirroring the Rust shrink loop.
      for (let i = values.length; ; i++) {
        if (!credStore.map.delete(`cred:${id}:${i}`)) break;
      }
    }),
    credentialDelete: vi.fn(async (id: string) => {
      for (let i = 0; ; i++) {
        if (!credStore.map.delete(`cred:${id}:${i}`)) break;
      }
    }),
  },
}));

vi.mock("@tauri-apps/plugin-store", () => {
  const handle = {
    get: vi.fn(async (key: string) => storeApi.seed.get(key)),
    set: vi.fn(async (key: string, value: unknown) => {
      storeApi.values.set(key, value);
    }),
    save: vi.fn(async () => {}),
  };
  return { load: vi.fn(async () => handle), __handle: handle };
});

beforeEach(() => {
  setActivePinia(createPinia());
  credStore.map.clear();
  credStore.failWrites = false;
  storeApi.seed.clear();
  storeApi.values.clear();
});

describe("isValidEnvKey", () => {
  it("accepts portable env var names", () => {
    expect(isValidEnvKey("AUTH_TOKEN")).toBe(true);
    expect(isValidEnvKey("_x1")).toBe(true);
  });
  it("rejects names that would break the child process env", () => {
    expect(isValidEnvKey("9BAD")).toBe(false);
    expect(isValidEnvKey("HAS SPACE")).toBe(false);
    expect(isValidEnvKey("")).toBe(false);
  });
});

describe("credentials store", () => {
  it("saves a token credential: values to keychain, metadata to JSON", async () => {
    const creds = useCredentialsStore();
    const meta = await creds.saveCredential({
      name: "Staging token",
      mode: "token",
      envKey: "AUTH_TOKEN",
      values: ["tok-a", "tok-b"],
    });
    await creds.flushPersist();
    expect(meta.valueCount).toBe(2);
    expect(credStore.map.get(`cred:${meta.id}:0`)).toBe("tok-a");
    expect(credStore.map.get(`cred:${meta.id}:1`)).toBe("tok-b");
    const persisted = storeApi.values.get("credentials.list") as Array<Record<string, unknown>>;
    expect(persisted[0].name).toBe("Staging token");
    // The JSON must never carry the secret values themselves.
    expect(JSON.stringify(persisted)).not.toContain("tok-a");
  });

  it("edit with blank values keeps the stored pool", async () => {
    const creds = useCredentialsStore();
    const meta = await creds.saveCredential({
      name: "t",
      mode: "token",
      envKey: "AUTH_TOKEN",
      values: ["one"],
    });
    const updated = await creds.saveCredential({
      id: meta.id,
      name: "renamed",
      mode: "token",
      envKey: "AUTH_TOKEN",
      values: null,
    });
    expect(updated.valueCount).toBe(1);
    expect(credStore.map.get(`cred:${meta.id}:0`)).toBe("one");
  });

  it("keychain write failure aborts the save and surfaces the error", async () => {
    const creds = useCredentialsStore();
    credStore.failWrites = true;
    await expect(
      creds.saveCredential({
        name: "t",
        mode: "token",
        envKey: "AUTH_TOKEN",
        values: ["x"],
      }),
    ).rejects.toThrow("keychain locked");
    expect(creds.storeError).toContain("keychain locked");
    // Nothing was added to the metadata list.
    expect(creds.items).toHaveLength(0);
  });

  it("basic mode stores usernames in metadata and passwords in keychain", async () => {
    const creds = useCredentialsStore();
    const meta = await creds.saveCredential({
      name: "accounts",
      mode: "basic",
      envKey: "AUTH_PASS",
      userEnvKey: "AUTH_USER",
      passEnvKey: "AUTH_PASS",
      users: ["alice", "bob"],
      values: ["pw1", "pw2"],
    });
    await creds.flushPersist();
    expect(meta.users).toEqual(["alice", "bob"]);
    expect(credStore.map.get(`cred:${meta.id}:0`)).toBe("pw1");
    expect(JSON.stringify(storeApi.values.get("credentials.list"))).not.toContain("pw1");
  });

  it("remove deletes keychain entries and selection", async () => {
    const creds = useCredentialsStore();
    const meta = await creds.saveCredential({
      name: "t",
      mode: "token",
      envKey: "AUTH_TOKEN",
      values: ["x", "y"],
    });
    creds.toggleSelected(meta.id);
    expect(creds.isSelected(meta.id)).toBe(true);
    await creds.removeCredential(meta.id);
    expect(creds.items).toHaveLength(0);
    expect(creds.isSelected(meta.id)).toBe(false);
    // Keychain cleanup is fire-and-forget; await the microtask queue.
    await new Promise((r) => setTimeout(r, 0));
    expect(credStore.map.size).toBe(0);
  });

  it("hydrate restores items and prunes stale selections", async () => {
    storeApi.seed.set("credentials.list", [
      { id: "cred-a", name: "A", mode: "token", envKey: "AUTH_TOKEN", valueCount: 1 },
      { id: "cred-b", name: "B", mode: "token", envKey: "T2", valueCount: 0 },
    ]);
    storeApi.seed.set("credentials.lastSelected", ["cred-a", "gone"]);
    const creds = useCredentialsStore();
    await creds.hydrate();
    expect(creds.items).toHaveLength(2);
    expect(creds.lastSelected).toEqual(["cred-a"]);
    expect(creds.ready).toBe(true);
  });

  it("briefs expose env names and pool sizes but never values", async () => {
    const creds = useCredentialsStore();
    await creds.saveCredential({
      name: "t",
      mode: "token",
      envKey: "AUTH_TOKEN",
      values: ["super-secret"],
    });
    const brief = creds.briefs[0];
    expect(brief).toMatchObject({ name: "t", mode: "token", envKey: "AUTH_TOKEN", valueCount: 1 });
    expect(JSON.stringify(creds.briefs)).not.toContain("super-secret");
  });

  it("toggleSelected persists the last selection", async () => {
    const creds = useCredentialsStore();
    const meta = await creds.saveCredential({
      name: "t",
      mode: "token",
      envKey: "AUTH_TOKEN",
      values: ["x"],
    });
    creds.toggleSelected(meta.id);
    await creds.flushPersist();
    expect(storeApi.values.get("credentials.lastSelected")).toEqual([meta.id]);
  });
});
