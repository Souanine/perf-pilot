import { describe, it, expect } from "vitest";
import {
  detectFormat,
  parseEnvImport,
  parseJsonImport,
  parseCsvImport,
  parseCredentialImport,
  splitCsvLine,
} from "@/lib/credential-import";

describe("detectFormat", () => {
  it("sniffs json / csv / env", () => {
    expect(detectFormat('[{"name":"a"}]')).toBe("json");
    expect(detectFormat("user,password\na,b")).toBe("csv");
    expect(detectFormat("TOKEN=abc\nBASE_URL=https://x")).toBe("env");
  });
});

describe("parseEnvImport", () => {
  it("maps each KEY=VALUE line to a token credential", () => {
    const out = parseEnvImport("TOKEN=abc123\nAPI_KEY=sk-x\n# comment\n");
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ name: "TOKEN", mode: "token", envKey: "TOKEN" });
    expect(out[0].values).toEqual(["abc123"]);
    expect(out[1].envKey).toBe("API_KEY");
  });

  it("keeps quoted values with spaces intact", () => {
    const out = parseEnvImport('BASE_URL="https://x.com?a=1&b=2"');
    expect(out[0].values[0]).toBe("https://x.com?a=1&b=2");
  });
});

describe("parseJsonImport", () => {
  it("accepts a bare array and defaults mode/envKey", () => {
    const out = parseJsonImport(JSON.stringify([{ name: "my token", values: ["t1"] }]));
    expect(out[0]).toMatchObject({ name: "my token", mode: "token", envKey: "MY_TOKEN" });
  });

  it("accepts the { credentials: [...] } wrapper", () => {
    const out = parseJsonImport(JSON.stringify({ credentials: [{ name: "a", values: ["x"] }] }));
    expect(out).toHaveLength(1);
  });

  it("skips entries without values or with mismatched basic pools", () => {
    const out = parseJsonImport(
      JSON.stringify([
        { name: "empty", values: [] },
        { name: "basic-bad", mode: "basic", values: ["p1", "p2"], users: ["only-one"] },
        { name: "ok", values: ["v"] },
      ]),
    );
    expect(out.map((d) => d.name)).toEqual(["ok"]);
  });

  it("stringifies oauth2 object values", () => {
    const out = parseJsonImport(
      JSON.stringify([
        {
          name: "oauth",
          mode: "oauth2_client",
          envKey: "OAUTH",
          tokenUrl: "https://auth/token",
          values: [{ id: "cid", secret: "sec" }],
        },
      ]),
    );
    expect(out[0].values[0]).toBe(JSON.stringify({ id: "cid", secret: "sec" }));
    expect(out[0].tokenUrl).toBe("https://auth/token");
  });

  it("throws on non-array JSON so the UI can show an error", () => {
    expect(() => parseJsonImport("not json")).toThrow();
    expect(() => parseJsonImport('{"nope": 1}')).toThrow();
  });
});

describe("splitCsvLine", () => {
  it("handles quoted fields with embedded commas and escapes", () => {
    expect(splitCsvLine('alice,"pw,with,commas"')).toEqual(["alice", "pw,with,commas"]);
    expect(splitCsvLine('bob,"say ""hi"" now"')).toEqual(["bob", 'say "hi" now']);
  });
});

describe("parseCsvImport", () => {
  it("two-column user,password becomes one basic pool", () => {
    const out = parseCsvImport("user,password\nalice,pw1\nbob,pw2");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ mode: "basic", userEnvKey: "AUTH_USER", passEnvKey: "AUTH_PASS" });
    expect(out[0].users).toEqual(["alice", "bob"]);
    expect(out[0].values).toEqual(["pw1", "pw2"]);
  });

  it("single column becomes one token pool", () => {
    const out = parseCsvImport("token\ntok-a\ntok-b");
    expect(out).toHaveLength(1);
    expect(out[0].mode).toBe("token");
    expect(out[0].values).toEqual(["tok-a", "tok-b"]);
  });

  it("single column without a header keeps every row", () => {
    const out = parseCsvImport("tok-a\ntok-b");
    expect(out[0].values).toEqual(["tok-a", "tok-b"]);
  });

  it("survives passwords containing commas", () => {
    const out = parseCsvImport('user,password\nalice,"a,b,c"');
    expect(out[0].values).toEqual(["a,b,c"]);
  });
});

describe("parseCredentialImport", () => {
  it("routes by sniffed format when none is given", () => {
    expect(parseCredentialImport("TOKEN=x")[0].mode).toBe("token");
    expect(parseCredentialImport("user,password\na,b")[0].mode).toBe("basic");
  });
  it("honours an explicit format override", () => {
    expect(parseCredentialImport("TOKEN=x", "env")).toHaveLength(1);
  });
});
