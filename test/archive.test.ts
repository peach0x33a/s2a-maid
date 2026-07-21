import { describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { AccountInputError } from "../src/accounts";
import { extractJsonFilesFromZip, isZipArchive } from "../src/archive";

describe("ZIP account input", () => {
  test("recognizes ZIP signatures and file names", () => {
    expect(isZipArchive(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), "accounts.bin")).toBe(true);
    expect(isZipArchive(new Uint8Array(), "ACCOUNTS.ZIP")).toBe(true);
    expect(isZipArchive(strToU8("{}"), "account.json")).toBe(false);
  });

  test("extracts nested JSON files and ignores other files", async () => {
    const archive = zipSync({
      "b/account.json": strToU8('{"name":"two"}'),
      "a.json": strToU8("\uFEFF{\"name\":\"one\"}"),
      "notes.txt": strToU8("ignore me"),
    });
    expect(await extractJsonFilesFromZip(archive)).toEqual([
      { name: "a.json", text: '{"name":"one"}' },
      { name: "b/account.json", text: '{"name":"two"}' },
    ]);
  });

  test("rejects archives without JSON files", async () => {
    const archive = zipSync({ "notes.txt": strToU8("nothing") });
    await expect(extractJsonFilesFromZip(archive)).rejects.toThrow(AccountInputError);
    await expect(extractJsonFilesFromZip(archive)).rejects.toThrow("没有找到 JSON 文件");
  });

  test("rejects invalid or encrypted-looking ZIP input", async () => {
    await expect(extractJsonFilesFromZip(strToU8("not a zip"))).rejects.toThrow("无法解压");
  });
});
