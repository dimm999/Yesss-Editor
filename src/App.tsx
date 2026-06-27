import { useEffect, useState, useCallback, useRef } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Image from "@tiptap/extension-image";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  readTextFile,
  writeTextFile,
  writeFile,
  readFile,
  readDir,
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
}

interface MdFile {
  name: string;
  path: string;
}

const DEFAULT_CONFIG: Config = {
  theme: "light.json",
  font_size: 18,
  font_name:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
};

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
const EDITOR_WIDTH_STEP = 50;

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
      baseDir: BaseDirectory.AppData,
    });
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

async function saveConfig(config: Config) {
  await writeTextFile(
    "config.json",
    JSON.stringify(config, null, 2),
    { baseDir: BaseDirectory.AppData }
  );
}

async function loadTheme(name: string): Promise<Theme> {
  try {
    const raw = await readTextFile(`themes/${name}`, {
      baseDir: BaseDirectory.AppData,
    });
    return JSON.parse(raw);
  } catch {
    return DEFAULT_THEME;
  }
}

async function listThemes(): Promise<string[]> {
  try {
    const entries = await readDir("themes", {
      baseDir: BaseDirectory.AppData,
    });
    return entries
      .filter((e) => e.name?.endsWith(".json"))
      .map((e) => e.name!)
      .sort();
  } catch {
    return ["light.json"];
  }
}

async function scanMdFiles(dirPath: string): Promise<MdFile[]> {
  const normalized = dirPath.replace(/\\/g, "/");
  const results: MdFile[] = [];
  try {
    const entries = await readDir(normalized);
    for (const entry of entries) {
      if (!entry.name) continue;
      const fullPath = `${normalized}/${entry.name}`;
      if (entry.isDirectory) {
        const nested = await scanMdFiles(fullPath);
        results.push(...nested);
      } else if (entry.name.endsWith(".md")) {
        results.push({ name: entry.name, path: fullPath });
      }
    }
  } catch (e) {
    console.error("scanMdFiles error:", e);
  }
  return results;
}

function fuzzyMatch(query: string, target: string): boolean {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
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

  configRef.current = config;
  themeListRef.current = themeList;
  hasUnsavedRef.current = hasUnsavedChanges;
  currentFileRef.current = currentFile;
  currentFolderRef.current = currentFolder;
  showCommandPaletteRef.current = showCommandPalette;
  paletteFilesRef.current = paletteFiles;
  paletteIndexRef.current = paletteIndex;
  paletteQueryRef.current = paletteQuery;
  imagePreviewIndexRef.current = imagePreviewIndex;

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

  async function handleQuit() {
    if (hasUnsavedRef.current) {
      const confirmed = await ask(
        "You have unsaved changes. Quit anyway?",
        { title: "Yesss Editor", kind: "warning" }
      );
      if (!confirmed) return;
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
    const content = ed.getHTML();
    await writeTextFile(filePath, content);
    setHasUnsavedChanges(false);
    showToast("File saved");
  }

  function newFile() {
    if (editorRef.current) {
      editorRef.current.commands.setContent("");
    }
    setCurrentFile(null);
    setHasUnsavedChanges(false);
  }

  async function openFile() {
    const selected = await open({
      multiple: false,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!selected) return;
    const filePath = selected as string;
    const content = await readTextFile(filePath);
    setCurrentFile(filePath);
    setCurrentFolder(getDir(filePath));
    setHasUnsavedChanges(false);
    if (editorRef.current) {
      editorRef.current.commands.setContent(content);
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
    const content = await readTextFile(file.path);
    setCurrentFile(file.path);
    setHasUnsavedChanges(false);
    if (editorRef.current) {
      editorRef.current.commands.setContent(content);
    }
    closeCommandPalette();
  }

  const paletteFiltered = paletteQuery
    ? paletteFiles.filter((f) => fuzzyMatch(paletteQuery, f.name))
    : paletteFiles;

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({
        placeholder: "Start typing...",
      }),
      Image,
    ],
    autofocus: "end",
    onUpdate: () => {
      setHasUnsavedChanges(true);
    },
    editorProps: {
      handleDOMEvents: {
        click: (_view, event) => {
          handleImageClick(event);
          return false;
        },
        dragstart: (_view, event) => {
          const target = (event as DragEvent).target as HTMLElement;
          if (target.tagName === "IMG") {
            (event as DragEvent).dataTransfer?.setData("text/uri-list", target.getAttribute("src") || "");
          }
          return false;
        },
        drop: (view, event) => {
          const de = event as DragEvent;
          const draggedSrc = de.dataTransfer?.getData("text/uri-list") || "";
          const dropTarget = de.target as HTMLElement;
          if (dropTarget.tagName !== "IMG") return false;
          const dropSrc = dropTarget.getAttribute("src") || "";
          if (!draggedSrc || draggedSrc === dropSrc) return false;
          event.preventDefault();
          const html = view.dom.innerHTML;
          const tmp = document.createElement("div");
          tmp.innerHTML = html;
          const imgs = Array.from(tmp.querySelectorAll("img"));
          const dragIdx = imgs.findIndex((img) => img.getAttribute("src") === draggedSrc);
          const dropIdx = imgs.findIndex((img) => img.getAttribute("src") === dropSrc);
          if (dragIdx < 0 || dropIdx < 0 || dragIdx === dropIdx) return true;
          const dragNode = imgs[dragIdx];
          const dropNode = imgs[dropIdx];
          const dragClone = dragNode.cloneNode(true);
          dragNode.replaceWith(dropNode.cloneNode(true));
          const allImgs = Array.from(tmp.querySelectorAll("img"));
          allImgs[dropIdx].replaceWith(dragClone);
          editorRef.current?.commands.setContent(tmp.innerHTML);
          return true;
        },
        paste: (_view, event) => {
          const items = (event as ClipboardEvent).clipboardData?.items;
          if (!items) return false;
          for (const item of Array.from(items)) {
            if (item.type.startsWith("image/")) {
              event.preventDefault();
              const file = item.getAsFile();
              if (file) insertImageFromFile(file);
              return true;
            }
          }
          return false;
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
    const html = editorRef.current.getHTML();
    const div = document.createElement("div");
    div.innerHTML = html;
    return Array.from(div.querySelectorAll("img")).map((img) => img.getAttribute("src") || "");
  }

  function handleImageClick(e: Event) {
    const target = e.target as HTMLElement;
    if (target.tagName !== "IMG") return;
    const src = target.getAttribute("src");
    if (!src) return;
    e.preventDefault();
    const images = getAllImages();
    const idx = images.indexOf(src);
    setImagePreviewIndex(idx >= 0 ? idx : 0);
  }

  async function saveImageToFile(src: string) {
    const selected = await save({
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }],
    });
    if (!selected) return;
    try {
      const response = await fetch(src);
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
    const mdName = getBase(filePath).replace(/\.md$/, "") || "doc";
    const srcName = getBase(srcPath) || "image.png";
    const ext = srcName.split(".").pop() || "png";
    const baseName = srcName.replace(/\.[^.]+$/, "");
    const imgName = `${mdName}-image-${baseName}.${ext}`;
    const imgPath = `${folder}/${imgName}`;

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
    const mdName = getBase(filePath).replace(/\.md$/, "") || "doc";
    const imgName = `${mdName}-image-${baseName}.${ext}`;
    const imgPath = `${folder}/${imgName}`;

    const arrayBuffer = await file.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuffer);
    await writeFile(imgPath, uint8);

    const blobUrl = URL.createObjectURL(file);
    ed.chain().focus().setImage({ src: blobUrl, alt: file.name }).run();
  }

  useEffect(() => {
    if (editor) editorRef.current = editor;
  }, [editor]);

  useEffect(() => {
    if (!ready || !editor) return;

    const unlisten = getCurrentWindow().onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      const paths = event.payload.paths;
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
      setReady(true);
    }
    init();
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
          if (paletteFilesRef.current[idx]) {
            selectPaletteFile(paletteFilesRef.current[idx]);
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
        const el = document.querySelector(".tiptap") as HTMLElement;
        const current = el ? (parseInt(el.style.maxWidth) || 900) : 900;
        applyEditorWidth(Math.min(current + EDITOR_WIDTH_STEP, EDITOR_WIDTH_MAX));
        return;
      }
      if (mod && code === "Quote") {
        e.preventDefault();
        const el = document.querySelector(".tiptap") as HTMLElement;
        const current = el ? (parseInt(el.style.maxWidth) || 900) : 900;
        applyEditorWidth(Math.max(current - EDITOR_WIDTH_STEP, EDITOR_WIDTH_MIN));
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

    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
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
              <svg width="12" height="12" viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8" rx="1" stroke="currentColor" stroke-width="1" fill="none"/></svg>
            </button>
            <button
              className="window-btn window-btn-close"
              title="Close"
              onClick={(e) => {
                e.stopPropagation();
                handleQuit();
              }}
            >
              <svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
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
        </div>
        {zenMode && showInfoPanel && (
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
                <span className="info-value">{currentFile ? getBase(currentFile) : "—"}</span>
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
                  {hasUnsavedChanges ? "🔴 Unsaved" : "🟢 Saved"}
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
                  {file.name}
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
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                </button>
                <button className="image-preview-btn" title="Close" onClick={(e) => { e.stopPropagation(); setImagePreviewIndex(null); }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
            </div>
            <div className="image-preview-body" onClick={(e) => e.stopPropagation()}>
              {images.length > 1 && (
                <button className="image-preview-nav image-preview-nav-left" title="Previous" onClick={() => setImagePreviewIndex((prev) => prev !== null ? (prev - 1 + images.length) % images.length : 0)}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
                </button>
              )}
              <img src={src} className="image-preview-img" />
              {images.length > 1 && (
                <button className="image-preview-nav image-preview-nav-right" title="Next" onClick={() => setImagePreviewIndex((prev) => prev !== null ? (prev + 1) % images.length : 0)}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                </button>
              )}
            </div>
          </div>
        );
      })()}
      {toast && (
        <div className="toast">{toast}</div>
      )}
    </div>
  );
}

export default App;
