import { describe, expect, it } from "vitest";
import { orderCode, randomToken, sha256Hex } from "../src/codes";

describe("orderCode", () => {
  it("is a short word plus two digits", () => {
    for (let i = 0; i < 200; i++) {
      expect(orderCode()).toMatch(/^[A-Z]{3,5}-\d{2}$/);
    }
  });
});

describe("randomToken", () => {
  it("is long, URL-safe and different each time", () => {
    const a = randomToken();
    const b = randomToken();
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b);
  });
});

describe("sha256Hex", () => {
  it("matches the known digest of 'abc'", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
