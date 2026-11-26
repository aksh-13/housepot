import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import manifest from "@/app/manifest";

/** Width and height from a PNG file's header. */
function pngSize(file: string): { width: number; height: number } {
  const bytes = readFileSync(path.resolve(__dirname, "..", file));
  expect(bytes.subarray(1, 4).toString()).toBe("PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test("the app can be installed to a phone's home screen", () => {
  const m = manifest();
  expect(m).toMatchObject({
    name: "Housepot",
    short_name: "Housepot",
    start_url: "/",
    display: "standalone",
    background_color: "#151411",
    theme_color: "#151411",
  });
});

test("the manifest lists the icon sizes phones ask for, and each file is that size", () => {
  const icons = manifest().icons ?? [];
  expect(icons.map((i) => [i.src, i.sizes, i.purpose])).toEqual([
    ["/icons/icon-192.png", "192x192", "any"],
    ["/icons/icon-512.png", "512x512", "any"],
    ["/icons/icon-maskable-512.png", "512x512", "maskable"],
  ]);
  expect(pngSize("public/icons/icon-192.png")).toEqual({ width: 192, height: 192 });
  expect(pngSize("public/icons/icon-512.png")).toEqual({ width: 512, height: 512 });
  expect(pngSize("public/icons/icon-maskable-512.png")).toEqual({ width: 512, height: 512 });
});

test("iPhones get their own home-screen icon and browsers get a tab icon", () => {
  expect(pngSize("src/app/apple-icon.png")).toEqual({ width: 180, height: 180 });
  expect(pngSize("src/app/icon.png")).toEqual({ width: 64, height: 64 });
});
