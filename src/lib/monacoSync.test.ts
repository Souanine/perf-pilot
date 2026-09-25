import { describe, it, expect } from "vitest";
import { planMonacoSync } from "@/lib/monacoSync";

describe("planMonacoSync", () => {
  it("returns noop when the value hasn't changed", () => {
    expect(planMonacoSync("hello", "hello")).toEqual({ kind: "noop" });
  });

  it("returns append with the delta when newValue extends oldValue", () => {
    const action = planMonacoSync("hello", "hello world");
    expect(action).toEqual({ kind: "append", delta: " world" });
  });

  it("returns set when the value diverged mid-string", () => {
    const action = planMonacoSync("hello", "help me");
    expect(action).toEqual({ kind: "set", value: "help me" });
  });

  it("returns set when the new value is shorter", () => {
    const action = planMonacoSync("hello world", "hello");
    expect(action).toEqual({ kind: "set", value: "hello" });
  });

  it("returns set for an empty oldValue (not append)", () => {
    // A zero-length oldValue would make "starts with" trivially true,
    // but a single setValue is cheaper than N empty-range edits during
    // the first streaming chunk.
    expect(planMonacoSync("", "hello")).toEqual({ kind: "set", value: "hello" });
  });

  it("returns set when the new value is unrelated", () => {
    expect(planMonacoSync("foo", "bar")).toEqual({ kind: "set", value: "bar" });
  });
});
