import { describe, it, expect } from "vitest";
import { shellSplit, parseEnvLines } from "@/lib/shellSplit";

describe("shellSplit", () => {
  it("returns an empty array for empty input", () => {
    expect(shellSplit("")).toEqual([]);
    expect(shellSplit("   ")).toEqual([]);
  });

  it("splits on whitespace outside quotes", () => {
    expect(shellSplit("foo bar baz")).toEqual(["foo", "bar", "baz"]);
  });

  it("collapses runs of whitespace", () => {
    expect(shellSplit("foo   bar\tbaz")).toEqual(["foo", "bar", "baz"]);
  });

  it("preserves whitespace inside double quotes", () => {
    expect(shellSplit('foo "hello world" bar')).toEqual([
      "foo",
      "hello world",
      "bar",
    ]);
  });

  it("preserves whitespace inside single quotes", () => {
    expect(shellSplit("foo 'hello world' bar")).toEqual([
      "foo",
      "hello world",
      "bar",
    ]);
  });

  it("preserves URL query strings inside double quotes", () => {
    // The motivating case: k6 BASE_URL often contains ?a=1&b=2.
    expect(
      shellSplit('--vus 10 BASE_URL="https://api.example.com?token=abc&page=2"'),
    ).toEqual([
      "--vus",
      "10",
      "BASE_URL=https://api.example.com?token=abc&page=2",
    ]);
  });

  it("interprets backslash escapes outside quotes", () => {
    expect(shellSplit("foo\\ bar")).toEqual(["foo bar"]);
  });

  it("treats backslash literally inside single quotes", () => {
    expect(shellSplit("'foo\\bar'")).toEqual(["foo\\bar"]);
  });

  it("leaves unterminated quotes lenient", () => {
    // We don't throw — the user can fix the next char.
    expect(shellSplit('foo "unterminated')).toEqual(["foo", "unterminated"]);
  });

  it("handles adjacent quoted segments as one token", () => {
    expect(shellSplit('"hello"world')).toEqual(["helloworld"]);
    expect(shellSplit("'foo''bar'")).toEqual(["foobar"]);
  });
});

describe("parseEnvLines", () => {
  it("parses simple KEY=VALUE lines", () => {
    expect(parseEnvLines("A=1\nB=2")).toEqual({ A: "1", B: "2" });
  });

  it("trims whitespace around the key and value", () => {
    expect(parseEnvLines("  TOKEN  =  abc  ")).toEqual({ TOKEN: "abc" });
  });

  it("preserves spaces inside a quoted value", () => {
    expect(parseEnvLines('LABEL="a b c"')).toEqual({ LABEL: "a b c" });
  });

  it("preserves URL query strings in a quoted value", () => {
    expect(
      parseEnvLines('BASE_URL="https://x.com?a=1&b=2"'),
    ).toEqual({ BASE_URL: "https://x.com?a=1&b=2" });
  });

  it("skips blank lines and comments", () => {
    expect(parseEnvLines("# comment\n\nA=1\n")).toEqual({ A: "1" });
  });

  it("ignores lines without an equals sign", () => {
    expect(parseEnvLines("A=1\njust-a-word\nB=2")).toEqual({ A: "1", B: "2" });
  });
});
