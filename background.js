// ツールバーのアイコン（または Alt+Shift+H）で、ページに save.js を差し込む。
// 画像・CSS・フォントの取得はここで行う。拡張機能の側から取ると、
// 別のドメインにある素材も CORS に止められずに取れるため。

const MAX_BYTES = 30 * 1024 * 1024; // 1つの素材の上限。超えたものは埋め込まず、URL のまま残す

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id == null) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["save.js"] });
  } catch (err) {
    // chrome:// のページなど、拡張機能が入れないページ
    console.warn(err);
    await setBadge(tab.id, "×", "#ce0000");
    setTimeout(() => setBadge(tab.id, "", "#000"), 2000);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "sph:fetch" || sender.id !== chrome.runtime.id) return false;
  fetchResource(msg.url, msg.as)
    .then((value) => sendResponse({ ok: true, value }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true; // 返事を後で送る
});

// as が "text" なら文字列（CSS）、"data" なら data: URL を返す
async function fetchResource(url, as) {
  if (!/^https?:/i.test(url)) throw new Error(`取れない URL: ${url}`);
  const res = await fetch(url, { credentials: "include", cache: "force-cache" });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  if (Number(res.headers.get("content-length")) > MAX_BYTES) throw new Error(`大きすぎる: ${url}`);
  if (as === "text") return await res.text();

  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) throw new Error(`大きすぎる: ${url}`);
  let type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!type || type === "application/octet-stream" || type === "text/plain") type = guessType(url) || type || "application/octet-stream";
  return `data:${type};base64,${toBase64(new Uint8Array(buf))}`;
}

const TYPES = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  avif: "image/avif", svg: "image/svg+xml", ico: "image/x-icon", bmp: "image/bmp",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  eot: "application/vnd.ms-fontobject", css: "text/css",
};

function guessType(url) {
  try {
    const ext = new URL(url).pathname.split(".").pop().toLowerCase();
    return TYPES[ext] || "";
  } catch (_) {
    return "";
  }
}

function toBase64(bytes) {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function setBadge(tabId, text, color) {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
    await chrome.action.setBadgeText({ tabId, text });
  } catch (_) {
    // タブが閉じられた場合などは無視する
  }
}
