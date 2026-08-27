import { vi } from "vitest";

export const S3Client = vi.fn(function S3Client() {
  return { send: vi.fn().mockResolvedValue({}) };
});

export const PutObjectCommand = vi.fn(function PutObjectCommand(input) {
  return { input };
});
