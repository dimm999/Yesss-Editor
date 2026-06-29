import { mkdirSync, copyFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const platform = process.platform;
let configDir;
if (platform === "win32") {
  configDir = join(homedir(), "AppData", "Roaming", "yesss-editor");
} else if (platform === "darwin") {
  configDir = join(homedir(), "Library", "Application Support", "yesss-editor");
} else {
  configDir = join(homedir(), ".config", "yesss-editor");
}
const appDir = configDir;
const themeDir = join(appDir, "themes");

mkdirSync(themeDir, { recursive: true });

const files = [
  ["config.json", "config.json"],
  ["themes/light.json", "themes/light.json"],
  ["themes/dark.json", "themes/dark.json"],
  ["themes/catppuccin.json", "themes/catppuccin.json"],
  ["themes/tokyo-night.json", "themes/tokyo-night.json"],
  ["themes/espresso.json", "themes/espresso.json"],
];

for (const [src, dest] of files) {
  const srcPath = join(import.meta.dirname, "..", src);
  const destPath = join(appDir, dest);
  if (existsSync(srcPath)) {
    copyFileSync(srcPath, destPath);
  }
}
