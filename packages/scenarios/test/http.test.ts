import { describe, expect, it } from "vitest";
import { urlHosts } from "../src/lib/http.ts";

describe("the hosts a browser context marks synthetic", () => {
  it("keeps the hosts of http and https origins and skips everything else", () => {
    expect(
      urlHosts([
        "https://app.example",
        "http://localhost:5173/some/path",
        "live",
        "Live site",
        "mailto:someone@example",
        undefined,
        "https://app.example/other",
      ]),
    ).toEqual(new Set(["app.example", "localhost:5173"]));
  });
});
