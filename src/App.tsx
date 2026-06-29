import { useEffect, useState, useCallback, useRef } from "react";
import { useEditor, EditorContent, BubbleMenu } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import { Node, mergeAttributes } from "@tiptap/core";
import markdownit from "markdown-it";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  readTextFile,
  writeTextFile,
  writeFile,
  readFile,
  readDir,
  exists,
  BaseDirectory,
} from "@tauri-apps/plugin-fs";
import { ask, save, open } from "@tauri-apps/plugin-dialog";
import { exit } from "@tauri-apps/plugin-process";
import "./App.css";

interface Theme {
  name: string;
  background: string;
  text: string;
  selection: string;
  placeholder: string;
  heading: string;
  strong: string;
  em: string;
  s: string;
  "blockquote-border": string;
  "blockquote-text": string;
  "code-bg": string;
  "code-text": string;
  "pre-bg": string;
  "pre-text": string;
  hr: string;
  scrollbar: string;
  "scrollbar-hover": string;
}

interface Config {
  theme: string;
  font_size: number;
  font_name: string;
  editor_width: number;
}

interface MdFile {
  name: string;
  path: string;
  relativePath: string;
}

const DEFAULT_CONFIG: Config = {
  theme: "light.json",
  font_size: 18,
  font_name:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  editor_width: 900,
};

const md = markdownit({ html: true });

function jsonToMarkdown(json: any): string {
  const lines: string[] = [];
  function walk(node: any, listIndex?: number) {
    switch (node.type) {
      case "doc":
        node.content?.forEach((c: any) => walk(c));
        break;
      case "paragraph":
        lines.push(inlineText(node));
        lines.push("");
        break;
      case "heading":
        const level = node.attrs?.level || 1;
        lines.push("#".repeat(level) + " " + inlineText(node));
        lines.push("");
        break;
      case "bulletList":
        node.content?.forEach((c: any) => walk(c));
        lines.push("");
        break;
      case "listItem":
        lines.push("- " + inlineText(node));
        break;
      case "blockquote":
        node.content?.forEach((c: any) => {
          const txt = inlineText(c);
          lines.push("> " + txt);
        });
        lines.push("");
        break;
      case "codeBlock":
        lines.push("```" + (node.attrs?.language || ""));
        lines.push(node.content?.[0]?.text || "");
        lines.push("```");
        lines.push("");
        break;
      case "horizontalRule":
        lines.push("---");
        lines.push("");
        break;
      case "image":
        const alt = node.attrs?.alt || "";
        const src = node.attrs?.src || "";
        lines.push(`![${alt}](${src})`);
        lines.push("");
        break;
      default:
        node.content?.forEach((c: any) => walk(c));
    }
  }
  function inlineText(node: any): string {
    if (!node.content) return node.text || "";
    return node.content.map((c: any) => {
      if (c.type === "text") {
        let t = c.text || "";
        if (c.marks) {
          for (const m of c.marks) {
            if (m.type === "bold") t = `**${t}**`;
            if (m.type === "italic") t = `*${t}*`;
            if (m.type === "code") t = `\`${t}\``;
            if (m.type === "strike") t = `~~${t}~~`;
            if (m.type === "link") t = `[${t}](${m.attrs?.href || ""})`;
          }
        }
        return t;
      }
      if (c.type === "hardBreak") return "\n";
      if (c.type === "image") {
        const alt = (c.attrs?.alt || "").replace(/ /g, "%20");
        const src = (c.attrs?.src || "").replace(/ /g, "%20");
        return `![${alt}](${src})`;
      }
      return inlineText(c);
    }).join("");
  }
  walk(json);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

const suppressUpdateRef = { current: false };
const currentFolderModuleRef = { current: null as string | null };

const RelativeImage = Node.create({
  name: "image",
  group: "block",
  atom: true,
  addAttributes() {
    return {
      src: { default: null },
      alt: { default: null },
    };
  },
  parseHTML() {
    return [{ tag: "img[src]" }];
  },
  renderHTML({ HTMLAttributes }) {
    const folder = currentFolderModuleRef.current;
    const src = HTMLAttributes.src;
    const isRelative = src && !src.startsWith("http") && !src.startsWith("data:") && !src.startsWith("blob:");
    const decoded = isRelative ? decodeURIComponent(src) : src;
    const resolved = isRelative && folder ? convertFileSrc(`${folder}/${decoded}`) : decoded;
    return ["img", mergeAttributes(HTMLAttributes, { src: resolved })];
  },
});

function loadMarkdown(editor: any, content: string) {
  if (!content.trimStart().startsWith("<")) {
    content = content.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt, src) => {
      return `![${alt.replace(/ /g, "%20")}](${src.replace(/ /g, "%20")})`;
    });
  }
  let html: string;
  if (content.trimStart().startsWith("<")) {
    html = content;
  } else {
    html = md.render(content);
  }
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  tmp.querySelectorAll("img").forEach((img) => {
    const p = img.closest("p");
    if (!p) return;
    const after = document.createElement("p");
    let found = false;
    for (const child of Array.from(p.childNodes)) {
      if (child === img) { found = true; continue; }
      if (found) after.appendChild(child);
    }
    p.parentElement?.insertBefore(img, p.nextSibling);
    if (after.childNodes.length) p.parentElement?.insertBefore(after, img.nextSibling);
    if (!p.childNodes.length) p.remove();
  });
  suppressUpdateRef.current = true;
  editor.commands.setContent(tmp.innerHTML);
  suppressUpdateRef.current = false;
}

const DEFAULT_THEME: Theme = {
  name: "Light",
  background: "#ffffff",
  text: "#000000",
  selection: "#c2e8ff",
  placeholder: "#999999",
  heading: "#000000",
  strong: "#000000",
  em: "#333333",
  s: "#999999",
  "blockquote-border": "#cccccc",
  "blockquote-text": "#555555",
  "code-bg": "#f0f0f0",
  "code-text": "#c7254e",
  "pre-bg": "#f5f5f5",
  "pre-text": "#000000",
  hr: "#dddddd",
  scrollbar: "#cccccc",
  "scrollbar-hover": "#aaaaaa",
};

const FONT_SIZE_MIN = 10;
const FONT_SIZE_MAX = 40;
const FONT_SIZE_STEP = 2;
const FONT_SIZE_DEFAULT = 18;

const EDITOR_WIDTH_MIN = 400;
const EDITOR_WIDTH_MAX = 1200;
const EDITOR_WIDTH_STEP = 15;

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.style.setProperty("--bg", theme.background);
  root.style.setProperty("--text", theme.text);
  root.style.setProperty("--selection", theme.selection);
  root.style.setProperty("--placeholder", theme.placeholder);
  root.style.setProperty("--heading", theme.heading);
  root.style.setProperty("--strong", theme.strong);
  root.style.setProperty("--em", theme.em);
  root.style.setProperty("--s", theme.s);
  root.style.setProperty(
    "--blockquote-border",
    theme["blockquote-border"]
  );
  root.style.setProperty(
    "--blockquote-text",
    theme["blockquote-text"]
  );
  root.style.setProperty("--code-bg", theme["code-bg"]);
  root.style.setProperty("--code-text", theme["code-text"]);
  root.style.setProperty("--pre-bg", theme["pre-bg"]);
  root.style.setProperty("--pre-text", theme["pre-text"]);
  root.style.setProperty("--hr", theme.hr);
  root.style.setProperty("--scrollbar", theme.scrollbar);
  root.style.setProperty(
    "--scrollbar-hover",
    theme["scrollbar-hover"]
  );
}

function applyFontSize(size: number) {
  document.documentElement.style.setProperty("--font-size", `${size}px`);
  const tiptap = document.querySelector(".tiptap") as HTMLElement;
  if (tiptap) tiptap.style.fontSize = `${size}px`;
}

function applyFontFamily(family: string) {
  document.documentElement.style.setProperty(
    "--font-family",
    family
  );
}

function applyEditorWidth(width: number) {
  document.documentElement.style.setProperty("--editor-max-width", `${width}px`);
  const el = document.querySelector(".tiptap") as HTMLElement;
  if (el) el.style.setProperty("max-width", `${width}px`, "important");
}

async function loadConfig(): Promise<Config> {
  try {
    const raw = await readTextFile("config.json", {
      baseDir: BaseDirectory.AppConfig,
    });
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    const cfg = DEFAULT_CONFIG;
    try { await saveConfig(cfg); } catch {}
    return cfg;
  }
}

async function saveConfig(config: Config) {
  await writeTextFile(
    "config.json",
    JSON.stringify(config, null, 2),
    { baseDir: BaseDirectory.AppConfig }
  );
}

async function loadTheme(name: string): Promise<Theme> {
  for (const base of [BaseDirectory.Resource, BaseDirectory.AppConfig]) {
    try {
      const raw = await readTextFile(`themes/${name}`, { baseDir: base });
      return JSON.parse(raw);
    } catch {}
  }
  return DEFAULT_THEME;
}

async function listThemes(): Promise<string[]> {
  const all = new Set<string>();
  for (const base of [BaseDirectory.Resource, BaseDirectory.AppConfig]) {
    try {
      const entries = await readDir("themes", { baseDir: base });
      for (const e of entries) {
        if (e.name?.endsWith(".json")) all.add(e.name);
      }
    } catch {}
  }
  if (all.size === 0) return ["light.json"];
  return [...all].sort();
}

async function scanMdFiles(dirPath: string, rootPath?: string): Promise<MdFile[]> {
  const normalized = dirPath.replace(/\\/g, "/");
  const root = (rootPath || dirPath).replace(/\\/g, "/");
  const results: MdFile[] = [];
  try {
    const entries = await readDir(normalized);
    for (const entry of entries) {
      if (!entry.name) continue;
      const fullPath = `${normalized}/${entry.name}`;
      if (entry.isDirectory) {
        const nested = await scanMdFiles(fullPath, root);
        results.push(...nested);
      } else if (entry.name.endsWith(".md")) {
        const rel = fullPath.startsWith(root + "/") ? fullPath.slice(root.length + 1) : entry.name;
        results.push({ name: entry.name, path: fullPath, relativePath: rel });
      }
    }
  } catch (e) {
    console.error("scanMdFiles error:", e);
  }
  return results;
}

function fuzzyMatch(query: string, target: MdFile): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const t = target.relativePath.toLowerCase();
  let pos = 0;
  for (const word of words) {
    let qi = 0;
    let found = false;
    for (let ti = pos; ti < t.length && qi < word.length; ti++) {
      if (t[ti] === word[qi]) qi++;
      if (qi === word.length) { pos = ti + 1; found = true; break; }
    }
    if (!found) return false;
  }
  return true;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function App() {
  const [ready, setReady] = useState(false);
  const [config, setConfig] = useState<Config>(DEFAULT_CONFIG);
  const [zenMode, setZenMode] = useState(false);
  const [themeList, setThemeList] = useState<string[]>([]);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [currentFolder, setCurrentFolder] = useState<string | null>(null);
  const [showInfoPanel, setShowInfoPanel] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteFiles, setPaletteFiles] = useState<MdFile[]>([]);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [currentTime, setCurrentTime] = useState(formatTime(new Date()));
  const [toast, setToast] = useState<string | null>(null);
  const [imagePreviewIndex, setImagePreviewIndex] = useState<number | null>(null);
  const [quitDialog, setQuitDialog] = useState<{ resolve: (v: "save" | "discard" | "cancel") => void } | null>(null);
  const configRef = useRef(config);
  const themeListRef = useRef(themeList);
  const hasUnsavedRef = useRef(hasUnsavedChanges);
  const currentFileRef = useRef(currentFile);
  const currentFolderRef = useRef(currentFolder);
  const editorRef = useRef<any>(null);
  const showCommandPaletteRef = useRef(showCommandPalette);
  const paletteFilesRef = useRef(paletteFiles);
  const paletteIndexRef = useRef(paletteIndex);
  const paletteQueryRef = useRef(paletteQuery);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const imagePreviewIndexRef = useRef(imagePreviewIndex);
  const draggedImageRef = useRef<string | null>(null);
  const quitDialogRef = useRef(quitDialog);
  const widthIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  configRef.current = config;
  themeListRef.current = themeList;
  hasUnsavedRef.current = hasUnsavedChanges;
  currentFileRef.current = currentFile;
  currentFolderRef.current = currentFolder;
  currentFolderModuleRef.current = currentFolder;
  showCommandPaletteRef.current = showCommandPalette;
  paletteFilesRef.current = paletteFiles;
  paletteIndexRef.current = paletteIndex;
  paletteQueryRef.current = paletteQuery;
  imagePreviewIndexRef.current = imagePreviewIndex;
  quitDialogRef.current = quitDialog;

  function saveEditorWidth(width: number) {
    applyEditorWidth(width);
    const cfg = { ...configRef.current, editor_width: width };
    setConfig(cfg);
    saveConfig(cfg);
  }

  const switchTheme = useCallback(
    async (direction: "next" | "prev") => {
      const cfg = configRef.current;
      const list = themeListRef.current;
      if (list.length === 0) return;
      const currentIndex = list.indexOf(cfg.theme);
      const newIndex =
        direction === "next"
          ? (currentIndex + 1) % list.length
          : (currentIndex - 1 + list.length) % list.length;
      const newThemeName = list[newIndex];
      const theme = await loadTheme(newThemeName);
      applyTheme(theme);
      const newConfig = { ...cfg, theme: newThemeName };
      setConfig(newConfig);
      await saveConfig(newConfig);
    },
    []
  );

  async function askUnsavedChanges(): Promise<"save" | "discard" | "cancel"> {
    if (!hasUnsavedRef.current) return "discard";
    return new Promise<"save" | "discard" | "cancel">((resolve) => {
      setQuitDialog({ resolve });
    });
  }

  async function handleQuit() {
    const result = await askUnsavedChanges();
    if (result === "cancel") return;
    if (result === "save") {
      await saveFile();
      if (!currentFileRef.current) return;
    }
    await exit(0);
  }

  async function toggleZenMode() {
    const appWindow = getCurrentWindow();
    const isFullscreen = await appWindow.isFullscreen().catch(() => false);
    await appWindow.setFullscreen(!isFullscreen);
    setZenMode((prev) => !prev);
  }

  async function saveFile() {
    const ed = editorRef.current;
    if (!ed) return;
    let filePath = currentFileRef.current;
    if (!filePath) {
      const selected = await save({
        filters: [{ name: "Markdown", extensions: ["md"] }],
        defaultPath: currentFolderRef.current || undefined,
      });
      if (!selected) return;
      filePath = selected;
      setCurrentFile(filePath);
      const folder = getDir(filePath);
      setCurrentFolder(folder);
    }
    const content = jsonToMarkdown(ed.getJSON());
    await writeTextFile(filePath, content);
    setHasUnsavedChanges(false);
    showToast("File saved");
  }

  async function newFile() {
    const result = await askUnsavedChanges();
    if (result === "cancel") return;
    if (result === "save") {
      await saveFile();
      if (!currentFileRef.current) return;
    }
    if (editorRef.current) {
      editorRef.current.commands.setContent("");
    }
    setCurrentFile(null);
    setHasUnsavedChanges(false);
  }

  async function openFile() {
    const result = await askUnsavedChanges();
    if (result === "cancel") return;
    if (result === "save") {
      await saveFile();
      if (!currentFileRef.current) return;
    }
    const selected = await open({
      multiple: false,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!selected) return;
    const filePath = selected as string;
    const content = await readTextFile(filePath);
    setCurrentFile(filePath);
    setCurrentFolder(getDir(filePath));
    currentFolderRef.current = getDir(filePath);
    currentFolderModuleRef.current = getDir(filePath);
    setHasUnsavedChanges(false);
    if (editorRef.current) {
      loadMarkdown(editorRef.current, content);
    }
  }

  async function openFolder() {
    const selected = await open({
      directory: true,
      multiple: false,
    });
    if (!selected) return;
    setCurrentFolder((selected as string).replace(/\\/g, "/"));
  }

  function toggleInfoPanel() {
    setShowInfoPanel((prev) => !prev);
  }

  function showToast(message: string) {
    setToast(message);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 2000);
  }

  function openCommandPalette() {
    const folder = currentFolderRef.current;
    setShowCommandPalette(true);
    setPaletteQuery("");
    setPaletteIndex(0);
    if (folder) {
      scanMdFiles(folder).then(setPaletteFiles);
    } else {
      setPaletteFiles([]);
    }
  }

  function closeCommandPalette() {
    setShowCommandPalette(false);
    setPaletteQuery("");
    setPaletteFiles([]);
    setPaletteIndex(0);
  }

  async function selectPaletteFile(file: MdFile) {
    const result = await askUnsavedChanges();
    if (result === "cancel") return;
    if (result === "save") {
      await saveFile();
      if (!currentFileRef.current) return;
    }
    const content = await readTextFile(file.path);
    setCurrentFile(file.path);
    setCurrentFolder(getDir(file.path));
    currentFolderRef.current = getDir(file.path);
    currentFolderModuleRef.current = getDir(file.path);
    setHasUnsavedChanges(false);
    if (editorRef.current) {
      loadMarkdown(editorRef.current, content);
    }
    closeCommandPalette();
  }

  const paletteFiltered = paletteQuery
    ? paletteFiles.filter((f) => fuzzyMatch(paletteQuery, f))
    : paletteFiles;

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({
        placeholder: "Start typing...",
      }),
      RelativeImage,
      Underline,
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { class: "editor-link" },
      }),
    ],
    autofocus: "end",
    onUpdate: () => {
      if (!suppressUpdateRef.current) {
        setHasUnsavedChanges(true);
      }
    },
    editorProps: {
      handleDOMEvents: {
        click: (_view, event) => {
          handleImageClick(event);
          return false;
        },
        paste: (_view, event) => {
          const data = (event as ClipboardEvent).clipboardData;
          if (!data) return false;
          const imageExts = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"];
          const files: File[] = [];
          if (data.files && data.files.length > 0) {
            for (const f of Array.from(data.files)) {
              if (f.type.startsWith("image/")) files.push(f);
            }
          }
          if (files.length === 0) {
            const items = Array.from(data.items || []);
            for (const item of items) {
              if (item.type.startsWith("image/")) {
                const f = item.getAsFile();
                if (f) files.push(f);
              }
            }
          }
          if (files.length === 0) return false;
          event.preventDefault();
          (async () => {
            for (const f of files) {
              await insertImageFromFile(f);
            }
          })();
          return true;
        },
      },
    },
  });

  function getDir(p: string) {
    const normalized = p.replace(/\\/g, "/");
    const idx = normalized.lastIndexOf("/");
    return idx >= 0 ? normalized.substring(0, idx) : "";
  }

  function getBase(p: string) {
    return p.replace(/\\/g, "/").split("/").pop() || "";
  }

  function getAllImages(): string[] {
    if (!editorRef.current) return [];
    const images: string[] = [];
    const json = editorRef.current.getJSON();
    function walk(node: any) {
      if (node.type === "image" && node.attrs?.src) {
        images.push(node.attrs.src);
      }
      if (node.content) {
        for (const child of node.content) walk(child);
      }
    }
    walk(json);
    return images;
  }

  function resolveImageSrc(relativeSrc: string): string {
    const folder = currentFolderRef.current;
    if (!folder || !relativeSrc || relativeSrc.startsWith("http") || relativeSrc.startsWith("data:") || relativeSrc.startsWith("blob:")) {
      return relativeSrc;
    }
    const decoded = decodeURIComponent(relativeSrc);
    return convertFileSrc(`${folder}/${decoded}`);
  }

  function handleImageClick(e: Event) {
    const target = e.target as HTMLElement;
    if (target.tagName !== "IMG") return;
    const domSrc = target.getAttribute("src");
    if (!domSrc) return;
    e.preventDefault();
    const images = getAllImages();
    const idx = images.findIndex((s) => resolveImageSrc(s) === domSrc);
    setImagePreviewIndex(idx >= 0 ? idx : 0);
  }

  async function saveImageToFile(src: string) {
    const selected = await save({
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }],
    });
    if (!selected) return;
    try {
      const resolvedSrc = resolveImageSrc(src);
      const response = await fetch(resolvedSrc);
      const blob = await response.blob();
      const buffer = await blob.arrayBuffer();
      const uint8 = new Uint8Array(buffer);
      await writeFile(selected, uint8);
      showToast("Image saved");
    } catch {
      showToast("Failed to save image");
    }
  }

  async function copyImageToMdFolder(srcPath: string) {
    let filePath = currentFileRef.current;
    if (!filePath) {
      const confirmed = await ask(
        "Save the file first before inserting images.",
        { title: "Yesss Editor", kind: "info" }
      );
      if (!confirmed) return null;
      await saveFile();
      filePath = currentFileRef.current;
      if (!filePath) return null;
    }

    const folder = getDir(filePath);
    const srcName = getBase(srcPath) || "image.png";
    const ext = srcName.split(".").pop() || "png";
    const baseName = srcName.replace(/\.[^.]+$/, "");
    let imgName = `${baseName}.${ext}`;
    let imgPath = `${folder}/${imgName}`;
    let counter = 2;
    while (await exists(imgPath)) {
      imgName = `${baseName}-${counter}.${ext}`;
      imgPath = `${folder}/${imgName}`;
      counter++;
    }

    const data = await readFile(srcPath);
    await writeFile(imgPath, data);
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
    const blob = new Blob([data], { type: mime });
    return { imgPath, blobUrl: URL.createObjectURL(blob) };
  }

  async function insertImageFromFile(file: File) {
    const ed = editorRef.current;
    if (!ed) return;

    const ext = file.name.split(".").pop() || "png";
    const baseName = file.name.replace(/\.[^.]+$/, "");

    let filePath = currentFileRef.current;
    if (!filePath) {
      const confirmed = await ask(
        "Save the file first before inserting images.",
        { title: "Yesss Editor", kind: "info" }
      );
      if (!confirmed) return;
      await saveFile();
      filePath = currentFileRef.current;
      if (!filePath) return;
    }

    const folder = getDir(filePath);
    let imgName = `${baseName}.${ext}`;
    let imgPath = `${folder}/${imgName}`;
    let counter = 2;
    while (await exists(imgPath)) {
      imgName = `${baseName}-${counter}.${ext}`;
      imgPath = `${folder}/${imgName}`;
      counter++;
    }

    const arrayBuffer = await file.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuffer);
    await writeFile(imgPath, uint8);

    const pos = ed.state.selection.from;
    ed.chain().focus().insertContentAt(pos, { type: "image", attrs: { src: imgName, alt: file.name } }).run();
  }

  useEffect(() => {
    if (editor) editorRef.current = editor;
  }, [editor]);

  useEffect(() => {
    if (!ready || !editor) return;

    const unlisten = getCurrentWindow().onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      const paths = event.payload.paths;

      const mdPaths = paths.filter((p) => p.endsWith(".md"));
      if (mdPaths.length > 0) {
        (async () => {
          for (const p of mdPaths) {
            const result = await askUnsavedChanges();
            if (result === "cancel") break;
            if (result === "save") {
              await saveFile();
            }
            const content = await readTextFile(p);
            setCurrentFile(p);
            setCurrentFolder(getDir(p));
            currentFolderRef.current = getDir(p);
            currentFolderModuleRef.current = getDir(p);
            setHasUnsavedChanges(false);
            if (editorRef.current) {
              loadMarkdown(editorRef.current, content);
            }
          }
        })();
        return;
      }

      const imageExts = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"];
      const imagePaths = paths.filter((p) => {
        const ext = p.split(".").pop()?.toLowerCase() || "";
        return imageExts.includes(ext);
      });
      if (imagePaths.length === 0) return;
      (async () => {
        for (const p of imagePaths) {
          const data = await readFile(p);
          const name = p.split(/[/\\]/).pop() || "image.png";
          const ext = p.split(".").pop()?.toLowerCase() || "png";
          const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
          const file = new File([data], name, { type: mime });
          await insertImageFromFile(file);
        }
      })();
    });

    return () => { unlisten.then((fn) => fn()); };
  }, [ready, editor]);

  useEffect(() => {
    if (!editor) return;
    const el = editor.view.dom;

    function markDraggable() {
      el.querySelectorAll("img").forEach((img) => {
        img.setAttribute("draggable", "true");
      });
    }
    markDraggable();
    const observer = new MutationObserver(markDraggable);
    observer.observe(el, { childList: true, subtree: true });

    function onDragStart(e: DragEvent) {
      const target = e.target as HTMLElement;
      if (target.tagName === "IMG" && el.contains(target)) {
        draggedImageRef.current = target.getAttribute("src") || "";
        e.dataTransfer!.effectAllowed = "move";
      }
    }

    function onDragOver(e: DragEvent) {
      if (draggedImageRef.current) {
        e.preventDefault();
        e.dataTransfer!.dropEffect = "move";
      }
    }

    function onDrop(e: DragEvent) {
      const dragSrc = draggedImageRef.current;
      draggedImageRef.current = null;
      if (!dragSrc) return;
      const dropTarget = e.target as HTMLElement;
      const dropImg = dropTarget.tagName === "IMG" ? dropTarget : (dropTarget.closest("img") as HTMLElement | null);
      if (!dropImg || !el.contains(dropImg)) return;
      const dropSrc = dropImg.getAttribute("src") || "";
      if (dragSrc === dropSrc) return;
      e.preventDefault();
      e.stopPropagation();
      const json = editorRef.current?.getJSON();
      if (!json) return;
      const allNodes: { node: any; parent: any; index: number }[] = [];
      function collect(n: any, parent: any, idx: number) {
        allNodes.push({ node: n, parent, index: idx });
        if (n.content) n.content.forEach((c: any, i: number) => collect(c, n, i));
      }
      collect(json, null, 0);
      const imageNodes = allNodes.filter((n) => n.node.type === "image");
      const dragEntry = imageNodes.find((n) => n.node.attrs?.src === dragSrc);
      const dropEntry = imageNodes.find((n) => n.node.attrs?.src === dropSrc);
      if (!dragEntry || !dropEntry || dragEntry === dropEntry) return;
      const dragParent = dragEntry.parent;
      const dropParent = dropEntry.parent;
      const dragArr = dragParent?.content || json.content;
      const dropArr = dropParent?.content || json.content;
      const fromIdx = dragArr.indexOf(dragEntry.node);
      const toIdx = dropArr.indexOf(dropEntry.node);
      if (fromIdx < 0 || toIdx < 0) return;
      dragArr.splice(fromIdx, 1);
      const adjustedIdx = fromIdx < toIdx ? toIdx - 1 : toIdx;
      dropArr.splice(adjustedIdx, 0, dragEntry.node);
      editorRef.current?.commands.setContent(json);
    }

    document.addEventListener("dragstart", onDragStart, true);
    document.addEventListener("dragover", onDragOver, true);
    document.addEventListener("drop", onDrop, true);
    return () => {
      observer.disconnect();
      document.removeEventListener("dragstart", onDragStart, true);
      document.removeEventListener("dragover", onDragOver, true);
      document.removeEventListener("drop", onDrop, true);
    };
  }, [editor]);

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(formatTime(new Date()));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    async function init() {
      const cfg = await loadConfig();
      setConfig(cfg);
      const themes = await listThemes();
      setThemeList(themes);
      const theme = await loadTheme(cfg.theme);
      applyTheme(theme);
      applyFontSize(cfg.font_size);
      applyFontFamily(cfg.font_name);
      applyEditorWidth(cfg.editor_width);
      setReady(true);
    }
    init().catch(() => setReady(true));
  }, []);

  useEffect(() => {
    if (ready && editor) {
      editor.commands.focus("end");
    }
  }, [ready, editor]);

  useEffect(() => {
    if (!ready || !editor) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.code === "AltLeft" || e.code === "AltRight") {
        e.preventDefault();
        return;
      }

      const code = e.code;

      if (imagePreviewIndexRef.current !== null) {
        const images = getAllImages();
        if (code === "Escape") {
          e.preventDefault();
          setImagePreviewIndex(null);
          return;
        }
        if (code === "ArrowLeft") {
          e.preventDefault();
          setImagePreviewIndex((prev) => prev !== null ? (prev - 1 + images.length) % images.length : 0);
          return;
        }
        if (code === "ArrowRight") {
          e.preventDefault();
          setImagePreviewIndex((prev) => prev !== null ? (prev + 1) % images.length : 0);
          return;
        }
        return;
      }

      const mod = e.ctrlKey || e.metaKey;

      if (quitDialogRef.current) {
        if (code === "Escape") {
          e.preventDefault();
          quitDialogRef.current.resolve("cancel");
          setQuitDialog(null);
          return;
        }
        return;
      }

      if (showCommandPaletteRef.current) {
        if (code === "Escape") {
          e.preventDefault();
          closeCommandPalette();
          return;
        }
        if (code === "ArrowDown") {
          e.preventDefault();
          setPaletteIndex((prev) => Math.min(prev + 1, paletteFilesRef.current.length - 1));
          return;
        }
        if (code === "ArrowUp") {
          e.preventDefault();
          setPaletteIndex((prev) => Math.max(prev - 1, 0));
          return;
        }
        if (code === "Enter") {
          e.preventDefault();
          const idx = paletteIndexRef.current;
          const filtered = paletteQueryRef.current
            ? paletteFilesRef.current.filter((f) => fuzzyMatch(paletteQueryRef.current, f))
            : paletteFilesRef.current;
          if (filtered[idx]) {
            selectPaletteFile(filtered[idx]);
          }
          return;
        }
        return;
      }

      if (mod && code === "Equal") {
        e.preventDefault();
        const cfg = configRef.current;
        const s = Math.min(cfg.font_size + FONT_SIZE_STEP, FONT_SIZE_MAX);
        const c = { ...cfg, font_size: s };
        setConfig(c);
        applyFontSize(s);
        saveConfig(c);
        return;
      }
      if (mod && code === "Minus") {
        e.preventDefault();
        const cfg = configRef.current;
        const s = Math.max(cfg.font_size - FONT_SIZE_STEP, FONT_SIZE_MIN);
        const c = { ...cfg, font_size: s };
        setConfig(c);
        applyFontSize(s);
        saveConfig(c);
        return;
      }
      if (mod && code === "Digit0") {
        e.preventDefault();
        const cfg = configRef.current;
        const c = { ...cfg, font_size: FONT_SIZE_DEFAULT };
        setConfig(c);
        applyFontSize(FONT_SIZE_DEFAULT);
        saveConfig(c);
        return;
      }

      if (mod && code === "Semicolon") {
        e.preventDefault();
        if (!widthIntervalRef.current) {
          const apply = () => saveEditorWidth(Math.max(configRef.current.editor_width - EDITOR_WIDTH_STEP, EDITOR_WIDTH_MIN));
          apply();
          widthIntervalRef.current = setInterval(apply, 80);
        }
        return;
      }
      if (mod && code === "Quote") {
        e.preventDefault();
        if (!widthIntervalRef.current) {
          const apply = () => saveEditorWidth(Math.min(configRef.current.editor_width + EDITOR_WIDTH_STEP, EDITOR_WIDTH_MAX));
          apply();
          widthIntervalRef.current = setInterval(apply, 80);
        }
        return;
      }

      if (mod && e.shiftKey && code === "KeyF") {
        e.preventDefault();
        toggleZenMode();
        return;
      }

      if (mod && code === "BracketLeft") {
        e.preventDefault();
        switchTheme("prev");
        return;
      }
      if (mod && code === "BracketRight") {
        e.preventDefault();
        switchTheme("next");
        return;
      }

      if (mod && code === "KeyQ") {
        e.preventDefault();
        handleQuit();
        return;
      }

      if (mod && code === "KeyN") {
        e.preventDefault();
        newFile();
        return;
      }

      if (mod && code === "KeyS") {
        e.preventDefault();
        saveFile();
        return;
      }

      if (mod && !e.shiftKey && code === "KeyO") {
        e.preventDefault();
        openFile();
        return;
      }

      if (mod && e.shiftKey && code === "KeyO") {
        e.preventDefault();
        openFolder();
        return;
      }

      if (mod && code === "Backslash") {
        e.preventDefault();
        openCommandPalette();
        return;
      }

      if (mod && !e.shiftKey && (code === "Slash" || code === "Period")) {
        e.preventDefault();
        toggleInfoPanel();
        return;
      }
    }

    function handleKeyUp(e: KeyboardEvent) {
      if (widthIntervalRef.current && (e.code === "Semicolon" || e.code === "Quote")) {
        clearInterval(widthIntervalRef.current);
        widthIntervalRef.current = null;
      }
    }

    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("keyup", handleKeyUp, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("keyup", handleKeyUp, true);
      if (widthIntervalRef.current) {
        clearInterval(widthIntervalRef.current);
        widthIntervalRef.current = null;
      }
    };
  }, [ready, editor, switchTheme]);

  const wordCount = editor ? editor.getText().split(/\s+/).filter(Boolean).length : 0;
  const charCount = editor ? editor.getText().length : 0;

  if (!editor || !ready) return null;

  return (
    <div className={`app-container ${zenMode ? "zen" : ""}`}>
      <div className="drag-bar" data-tauri-drag-region>
        {!zenMode && (
          <div className="window-controls">
            <button
              className="window-btn"
              title="Minimize"
              onClick={(e) => {
                e.stopPropagation();
                getCurrentWindow().minimize();
              }}
            >
              <svg width="12" height="12" viewBox="0 0 12 12"><rect x="2" y="5.5" width="8" height="1" rx="0.5" fill="currentColor"/></svg>
            </button>
            <button
              className="window-btn"
              title="Maximize"
              onClick={(e) => {
                e.stopPropagation();
                getCurrentWindow().toggleMaximize();
              }}
            >
              <svg width="12" height="12" viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8" rx="1" stroke="currentColor" strokeWidth="1" fill="none"/></svg>
            </button>
            <button
              className="window-btn window-btn-close"
              title="Close"
              onClick={(e) => {
                e.stopPropagation();
                handleQuit();
              }}
            >
              <svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
            </button>
          </div>
        )}
      </div>
      <div className="main-content">
        <div
          className="editor-wrapper"
          onClick={(e) => {
            if (showInfoPanel) setShowInfoPanel(false);
            const target = e.target as HTMLElement;
            if (editorRef.current && !target.closest(".ProseMirror")) {
              editorRef.current.commands.focus("end");
            }
          }}
        >
          <EditorContent editor={editor} />
          {editor && (
            <BubbleMenu
              editor={editor}
              tippyOptions={{ duration: 150, placement: "top" }}
              shouldShow={({ editor: e, state }) => {
                if (!e.isFocused) return false;
                const { from, to } = state.selection;
                if (from === to) return false;
                const node = state.selection.$from.node(1) || state.doc.nodeAt(from);
                if (node?.type.name === "image") return false;
                return true;
              }}
            >
              <div className="bubble-menu">
                <button
                  className={`bubble-btn ${editor.isActive("bold") ? "active" : ""}`}
                  title="Bold"
                  onClick={() => editor.chain().focus().toggleBold().run()}
                >
                  <strong>B</strong>
                </button>
                <button
                  className={`bubble-btn ${editor.isActive("italic") ? "active" : ""}`}
                  title="Italic"
                  onClick={() => editor.chain().focus().toggleItalic().run()}
                >
                  <em>I</em>
                </button>
                <button
                  className={`bubble-btn ${editor.isActive("underline") ? "active" : ""}`}
                  title="Underline"
                  onClick={() => editor.chain().focus().toggleUnderline().run()}
                >
                  <u>U</u>
                </button>
                <button
                  className={`bubble-btn ${editor.isActive("strike") ? "active" : ""}`}
                  title="Strikethrough"
                  onClick={() => editor.chain().focus().toggleStrike().run()}
                >
                  <s>S</s>
                </button>
                <div className="bubble-separator" />
                <button
                  className={`bubble-btn ${editor.isActive("heading", { level: 2 }) ? "active" : ""}`}
                  title="Heading"
                  onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
                >
                  H2
                </button>
                <button
                  className={`bubble-btn ${editor.isActive("heading", { level: 3 }) ? "active" : ""}`}
                  title="Subheading"
                  onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
                >
                  H3
                </button>
                <div className="bubble-separator" />
                <button
                  className={`bubble-btn ${editor.isActive("bulletList") ? "active" : ""}`}
                  title="Bullet list"
                  onClick={() => editor.chain().focus().toggleBulletList().run()}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="3" cy="5" r="2"/><circle cx="3" cy="12" r="2"/><circle cx="3" cy="19" r="2"/><rect x="8" y="4" width="14" height="2" rx="1"/><rect x="8" y="11" width="14" height="2" rx="1"/><rect x="8" y="18" width="14" height="2" rx="1"/></svg>
                </button>
                <button
                  className={`bubble-btn ${editor.isActive("orderedList") ? "active" : ""}`}
                  title="Numbered list"
                  onClick={() => editor.chain().focus().toggleOrderedList().run()}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><text x="0" y="7" fontSize="8" fontWeight="bold">1.</text><text x="0" y="14" fontSize="8" fontWeight="bold">2.</text><text x="0" y="21" fontSize="8" fontWeight="bold">3.</text><rect x="8" y="4" width="14" height="2" rx="1"/><rect x="8" y="11" width="14" height="2" rx="1"/><rect x="8" y="18" width="14" height="2" rx="1"/></svg>
                </button>
                <button
                  className={`bubble-btn ${editor.isActive("blockquote") ? "active" : ""}`}
                  title="Quote"
                  onClick={() => editor.chain().focus().toggleBlockquote().run()}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M4 5h6v6H4zM14 5h6v6h-6zM4 14h12v2H4zM4 19h8v2H4z"/></svg>
                </button>
                <button
                  className={`bubble-btn ${editor.isActive("code") ? "active" : ""}`}
                  title="Inline code"
                  onClick={() => editor.chain().focus().toggleCode().run()}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
                </button>
              </div>
            </BubbleMenu>
          )}
        </div>
        {showInfoPanel && (
          <div className="info-panel">
            <button
              className="info-panel-close"
              onClick={() => setShowInfoPanel(false)}
            >
              ✕
            </button>
            <div className="info-panel-content">
              <div className="info-item">
                <span className="info-label">File</span>
                <span className="info-value">{currentFile ? (() => {
                  const base = currentFile.replace(/\\/g, "/");
                  const folder = currentFolder?.replace(/\\/g, "/") || "";
                  return folder && base.startsWith(folder + "/") ? base.slice(folder.length + 1) : getBase(currentFile);
                })() : "—"}</span>
              </div>
              <div className="info-item">
                <span className="info-label">Folder</span>
                <span className="info-value">{currentFolder ? getBase(currentFolder) : "—"}</span>
              </div>
              <div className="info-item">
                <span className="info-label">Words</span>
                <span className="info-value">{wordCount}</span>
              </div>
              <div className="info-item">
                <span className="info-label">Characters</span>
                <span className="info-value">{charCount}</span>
              </div>
              <div className="info-item">
                <span className="info-label">Status</span>
                <span className="info-value">
                  {currentFile ? (hasUnsavedChanges ? "🔴 Unsaved" : "🟢 Saved") : "🟡 New"}
                </span>
              </div>
              <div className="info-item">
                <span className="info-label">Time</span>
                <span className="info-value">{currentTime}</span>
              </div>
            </div>
          </div>
        )}
      </div>
      {showCommandPalette && (
        <div className="palette-overlay" onClick={closeCommandPalette}>
          <div className="palette" onClick={(e) => e.stopPropagation()}>
            <input
              className="palette-input"
              type="text"
              placeholder="Search files..."
              autoFocus
              value={paletteQuery}
              onChange={(e) => {
                setPaletteQuery(e.target.value);
                setPaletteIndex(0);
                paletteIndexRef.current = 0;
              }}
            />
            <div className="palette-list">
              {paletteFiltered.length === 0 && (
                <div className="palette-empty">No files found</div>
              )}
              {paletteFiltered.map((file, i) => (
                <div
                  key={file.path}
                  className={`palette-item ${i === paletteIndex ? "active" : ""}`}
                  onClick={() => selectPaletteFile(file)}
                  onMouseEnter={() => setPaletteIndex(i)}
                >
                  {file.relativePath}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {imagePreviewIndex !== null && (() => {
        const images = getAllImages();
        const src = images[imagePreviewIndex];
        if (!src) return null;
        return (
          <div className="image-preview-overlay" onClick={() => setImagePreviewIndex(null)}>
            <div className="image-preview-topbar">
              <span className="image-preview-counter">{imagePreviewIndex + 1} / {images.length}</span>
              <div className="image-preview-actions">
                <button className="image-preview-btn" title="Save image" onClick={(e) => { e.stopPropagation(); saveImageToFile(src); }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                </button>
                <button className="image-preview-btn" title="Close" onClick={(e) => { e.stopPropagation(); setImagePreviewIndex(null); }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
            </div>
            <div className="image-preview-body" onClick={(e) => e.stopPropagation()}>
              {images.length > 1 && (
                <button className="image-preview-nav image-preview-nav-left" title="Previous" onClick={() => setImagePreviewIndex((prev) => prev !== null ? (prev - 1 + images.length) % images.length : 0)}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
                </button>
              )}
              <img src={resolveImageSrc(src)} className="image-preview-img" />
              {images.length > 1 && (
                <button className="image-preview-nav image-preview-nav-right" title="Next" onClick={() => setImagePreviewIndex((prev) => prev !== null ? (prev + 1) % images.length : 0)}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                </button>
              )}
            </div>
          </div>
        );
      })()}
      {toast && (
        <div className="toast">{toast}</div>
      )}
      {quitDialog && (
        <div className="quit-dialog-overlay" onKeyDown={(e) => {
          if (e.key === "Escape") { quitDialog.resolve("cancel"); setQuitDialog(null); return; }
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            const btns = (e.currentTarget.querySelector(".quit-dialog-actions") as HTMLElement)?.children;
            if (!btns) return;
            const active = document.activeElement;
            let idx = Array.from(btns).indexOf(active as Element);
            if (idx === -1) idx = 0;
            else idx = e.key === "ArrowRight" ? (idx + 1) % btns.length : (idx - 1 + btns.length) % btns.length;
            (btns[idx] as HTMLElement).focus();
          }
          if (e.key === "Enter") {
            (document.activeElement as HTMLElement)?.click();
          }
        }}>
          <div className="quit-dialog">
            <p className="quit-dialog-text">You have unsaved changes.</p>
            <div className="quit-dialog-actions">
              <button autoFocus className="quit-dialog-btn quit-dialog-save" onClick={() => { quitDialog.resolve("save"); setQuitDialog(null); }}>Save</button>
              <button className="quit-dialog-btn quit-dialog-discard" onClick={() => { quitDialog.resolve("discard"); setQuitDialog(null); }}>Discard</button>
              <button className="quit-dialog-btn quit-dialog-cancel" onClick={() => { quitDialog.resolve("cancel"); setQuitDialog(null); }}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
