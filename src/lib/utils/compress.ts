import { brotliCompress, constants } from "node:zlib";
import { promisify } from "node:util";

const brotliCompressAsync = promisify(brotliCompress);

export async function brotliBuffer(input: string | Buffer): Promise<Buffer> {
  return brotliCompressAsync(Buffer.isBuffer(input) ? input : Buffer.from(input), {
    params: {
      // Static build artifact: spend CPU once for smaller GitHub Pages transfer/storage.
      [constants.BROTLI_PARAM_QUALITY]: 11,
    },
  });
}
