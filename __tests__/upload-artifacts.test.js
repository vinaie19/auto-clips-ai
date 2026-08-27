import { describe, expect, it, vi } from "vitest";

vi.mock("../worker/pipeline/storage.js", () => ({
  uploadFile: vi.fn(),
  publicUrl: vi.fn(),
}));

import { uploadFile, publicUrl } from "../worker/pipeline/storage.js";
import { uploadRenderArtifacts } from "../worker/pipeline/upload.js";

const base = { bucket: "renders", userId: "u", videoId: "1" };

describe("uploadRenderArtifacts", () => {
  it("uploads video + thumbnail with derived keys and returns public URLs", async () => {
    uploadFile.mockResolvedValue(undefined);
    publicUrl.mockImplementation((bucket, key) => `https://cdn/${key}`);

    const res = await uploadRenderArtifacts({}, {
      ...base,
      videoPath: "/tmp/v.mp4",
      thumbPath: "/tmp/t.jpg",
    });

    expect(uploadFile).toHaveBeenCalledWith({}, {
      bucket: "renders",
      key: "u/1.mp4",
      filePath: "/tmp/v.mp4",
      contentType: "video/mp4",
    });
    expect(uploadFile).toHaveBeenCalledWith({}, {
      bucket: "renders",
      key: "u/1.jpg",
      filePath: "/tmp/t.jpg",
      contentType: "image/jpeg",
    });
    expect(res).toEqual({
      videoUrl: "https://cdn/u/1.mp4",
      thumbnailUrl: "https://cdn/u/1.jpg",
    });
  });

  it("keeps the video URL when thumbnail upload fails", async () => {
    uploadFile.mockImplementation(async (_s, { key }) => {
      if (key.endsWith(".jpg")) throw new Error("thumb boom");
    });
    publicUrl.mockImplementation((bucket, key) => `https://cdn/${key}`);

    const res = await uploadRenderArtifacts({}, {
      ...base,
      videoPath: "/tmp/v.mp4",
      thumbPath: "/tmp/t.jpg",
    });

    expect(res.videoUrl).toBe("https://cdn/u/1.mp4");
    expect(res.thumbnailUrl).toBeNull();
  });
});
