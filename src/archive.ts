import { unzip } from "fflate";
import { AccountInputError } from "./accounts";

const MAX_JSON_FILES = 500;
const MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;

export interface ArchiveJsonFile {
  name: string;
  text: string;
}

export function isZipArchive(data: Uint8Array, fileName?: string): boolean {
  const hasZipSignature = data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b &&
    ((data[2] === 0x03 && data[3] === 0x04) || (data[2] === 0x05 && data[3] === 0x06) || (data[2] === 0x07 && data[3] === 0x08));
  return hasZipSignature || fileName?.toLowerCase().endsWith(".zip") === true;
}

export async function extractJsonFilesFromZip(data: Uint8Array): Promise<ArchiveJsonFile[]> {
  let selectedFiles = 0;
  let declaredBytes = 0;

  const extracted = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    unzip(data, {
      filter(file) {
        if (!file.name.toLowerCase().endsWith(".json") || file.name.endsWith("/")) return false;
        selectedFiles += 1;
        declaredBytes += file.originalSize;
        if (selectedFiles > MAX_JSON_FILES) throw new AccountInputError(`压缩包中的 JSON 文件不能超过 ${MAX_JSON_FILES} 个。`);
        if (declaredBytes > MAX_UNCOMPRESSED_BYTES) throw new AccountInputError("压缩包解压后的 JSON 文件总大小不能超过 50 MB。");
        return true;
      },
    }, (error, files) => error ? reject(error) : resolve(files));
  }).catch((error: unknown) => {
    if (error instanceof AccountInputError) throw error;
    throw new AccountInputError("无法解压这个 ZIP 文件，请确认压缩包完整且未加密。");
  });

  const entries = Object.entries(extracted).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) throw new AccountInputError("压缩包中没有找到 JSON 文件。");

  const actualBytes = entries.reduce((total, [, content]) => total + content.byteLength, 0);
  if (actualBytes > MAX_UNCOMPRESSED_BYTES) {
    throw new AccountInputError("压缩包解压后的 JSON 文件总大小不能超过 50 MB。");
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  return entries.map(([name, content]) => {
    try {
      return { name, text: decoder.decode(content).replace(/^\uFEFF/, "") };
    } catch {
      throw new AccountInputError(`压缩包中的 ${name} 不是有效的 UTF-8 文本。`);
    }
  });
}
