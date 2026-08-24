import { describe, expect, it } from "vitest";
import { chunkIntoPunchyBlocks } from "../worker/pipeline/captions.js";

describe("chunkIntoPunchyBlocks", () => {
  it("splits into short caption blocks", () => {
    const blocks = chunkIntoPunchyBlocks("one two three four five six seven", 3);
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.join(" ")).toContain("one");
  });
});
