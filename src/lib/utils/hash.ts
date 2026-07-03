import { createHash } from "node:crypto";

export function sha1Short(value: string, length = 16): string {
  return createHash("sha1").update(value).digest("hex").slice(0, length);
}

