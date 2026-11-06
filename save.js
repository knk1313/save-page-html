// 開いているページを、1つの HTML ファイルとして保存する。background.js が chrome.scripting で差し込む。
//
// しくみ：
// - いまの DOM（JS で書き換わった後の状態）を、別の文書へ1つずつ写し取る
// - CSS は CSSOM から書き出し、url() の画像やフォントを data: URL に置き換えて <style> に入れる
// - <img> などの画像も data: URL にする。素材の取得は background.js に頼む（CORS を避けるため）
// - <script> は外す。保存したファイルは、保存したときの見た目をそのまま表示するだけになる
// - 同じオリジンの <iframe> は中身を srcdoc に入れ、Shadow DOM は宣言的 Shadow DOM（<template shadowrootmode>）で書き出す

(() => {
  if (window.__savePageHtml) return; // 保存中にもう一度押されたときは何もしない
  window.__savePageHtml = true;

  const TOAST_TAG = "save-page-html-toast";
  const CONCURRENCY = 6; // 同時に取る素材の数
  const MAX_IMPORT_DEPTH = 5;

  // ---------------------------------------------------------------- 案内の表示

  const toast = createToast();

  function createToast() {
    const host = document.createElement(TOAST_TAG);
    host.style.cssText = [
      "all: initial",
      "position: fixed",
      "top: 16px",
      "left: 16px",
      "right: 16px",
      "z-index: 2147483647",
      "display: flex",
      "justify-content: center",
      "pointer-events: none",
    ].map((d) => d + " !important").join(";");
    const root = host.attachShadow({ mode: "closed" });
    // 見た目は full-page-screenshot のトップバー（デジタル庁デザインシステムのトークン）に合わせている
    root.innerHTML = `
      <style>
        :host {
          --surface: #ffffff; --text: #1a1a1a; --border: #949494; --primary: #0017c1;
          --success: #197a4b; --error: #ce0000; --muted: #666666;
          --shadow: 0 4px 16px 2px rgba(0,0,0,.12), 0 2px 6px 0 rgba(0,0,0,.3);
        }
        @media (prefers-color-scheme: dark) {
          :host {
            --surface: #1a1a1a; --text: #ffffff; --border: #767676; --primary: #9db7f9;
            --success: #71c598; --error: #ff9696; --muted: #b3b3b3;
            --shadow: 0 4px 16px 2px rgba(0,0,0,.5), 0 2px 6px 0 rgba(0,0,0,.6);
          }
        }
        .box {
          display: flex; align-items: center; gap: 12px; max-width: 100%;
          padding: 10px 10px 10px 16px; border: 1px solid var(--border); border-radius: 16px;
          background: var(--surface); box-shadow: var(--shadow); color: var(--text);
          font: 700 16px/1.5 "Noto Sans JP", -apple-system, BlinkMacSystemFont, "Hiragino Sans", Meiryo, sans-serif;
          pointer-events: auto;
        }
        .box[data-state="done"] .text { color: var(--success); }
        .box[data-state="error"] .text { color: var(--error); }
        /* スピナーと文字を flex で並べ、縦の中央をそろえる */
        .text { display: flex; align-items: center; gap: 8px; min-height: 40px; margin: 0; overflow-wrap: anywhere; }
        .box[data-state="busy"] .text::before {
          content: ""; flex: none; box-sizing: border-box; width: 18px; height: 18px;
          border: 2px solid var(--primary); border-right-color: transparent;
          border-radius: 50%; animation: spin .8s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        button {
          flex: none; display: inline-flex; align-items: center; justify-content: center;
          width: 40px; height: 40px; padding: 0; border: 0; border-radius: 12px;
          background: transparent; color: var(--muted); cursor: pointer;
        }
        button:hover { color: var(--text); }
        button:focus-visible { outline: 4px solid #000; outline-offset: 2px; box-shadow: 0 0 0 2px #ffd43d; }
        svg { width: 20px; height: 20px; }
      </style>
      <div class="box" data-state="busy">
        <p class="text" role="status" aria-live="polite">準備中…</p>
        <button type="button" aria-label="閉じる">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>`;
    const box = root.querySelector(".box");
    const text = root.querySelector(".text");
    root.querySelector("button").addEventListener("click", () => host.remove());
    document.documentElement.appendChild(host);
    return {
      set(state, message) {
        box.dataset.state = state;
        text.textContent = message;
      },
      closeLater(ms) {
        setTimeout(() => host.remove(), ms);
      },
    };
  }

  // ---------------------------------------------------------------- 素材の取得

  const cache = new Map(); // "as url" → Promise<string | null>
  let total = 0;
  let finished = 0;
  const queue = [];
  let active = 0;

  let ended = false; // 終わった（成功・失敗の表示を出した）後は、進み具合で上書きしない

  function showProgress() {
    if (!ended) toast.set("busy", `素材を埋め込み中… ${finished} / ${total}`);
  }

  // 取れなかったときは null を返す（呼んだ側で元の URL を残す）
  function fetchResource(url, as) {
    const key = `${as} ${url}`;
    if (!cache.has(key)) {
      total++;
      showProgress();
      const p = limit(() => doFetch(url, as))
        .catch((err) => {
          // 取れない素材はよくある（ページ自体が 404 の画像を指しているなど）。保存は続けるので、
          // 拡張機能のエラー欄に出る warn ではなく debug で記録する。件数は保存後の表示に出す
          console.debug("[save-page-html] 埋め込めなかった素材:", err?.message || err);
          return null;
        })
        .finally(() => {
          finished++;
          showProgress();
        });
      cache.set(key, p);
    }
    return cache.get(key);
  }

  async function doFetch(url, as) {
    // blob: の URL はこのページでしか読めないので、ここで読む
    if (url.startsWith("blob:")) {
      const blob = await (await fetch(url)).blob();
      return as === "text" ? await blob.text() : await blobToDataUrl(blob);
    }
    const res = await chrome.runtime.sendMessage({ type: "sph:fetch", url, as });
    if (!res?.ok) throw new Error(res?.error || "取得に失敗");
    return res.value;
  }

  function limit(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      pump();
    });
  }

  function pump() {
    while (active < CONCURRENCY && queue.length) {
      const { fn, resolve, reject } = queue.shift();
      active++;
      fn()
        .then(resolve, reject)
        .finally(() => {
          active--;
          pump();
        });
    }
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  function absolute(url, base) {
    try {
      return new URL(url, base).href;
    } catch (_) {
      return null;
    }
  }

  const canInline = (url) => /^(https?|blob):/i.test(url);

  // url を data: URL にする。できなければ絶対 URL を返す
  async function inlineUrl(url, base) {
    const abs = absolute(url, base);
    if (!abs || !canInline(abs)) return abs || url;
    return (await fetchResource(abs, "data")) ?? abs;
  }

  async function replaceAsync(text, re, fn) {
    const matches = [...text.matchAll(re)];
    if (!matches.length) return text;
    const values = await Promise.all(matches.map((m) => fn(...m)));
    let out = "";
    let last = 0;
    matches.forEach((m, i) => {
      out += text.slice(last, m.index) + values[i];
      last = m.index + m[0].length;
    });
    return out + text.slice(last);
  }

  // ---------------------------------------------------------------- CSS

  const URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)/gi;
  const IMPORT_RE = /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)|"([^"]*)"|'([^']*)')([^;]*);/gi;

  // CSS の中の url() を data: URL（だめなら絶対 URL）に置き換える
  function rewriteCssUrls(css, base) {
    return replaceAsync(css, URL_RE, async (whole, a, b, c) => {
      const url = (a ?? b ?? c ?? "").trim();
      if (!url || url.startsWith("#") || /^(data|about):/i.test(url)) return whole;
      return `url("${await inlineUrl(url, base)}")`;
    });
  }

  // CSSOM から読めない CSS（別のオリジンの CSS など）を、文字列のまま処理する
  async function processCssText(css, base, depth = 0) {
    css = await replaceAsync(css, IMPORT_RE, async (whole, a, b, c, d, e, condition) => {
      const url = absolute((a ?? b ?? c ?? d ?? e ?? "").trim(), base);
      if (!url || depth >= MAX_IMPORT_DEPTH) return "";
      const text = await fetchResource(url, "text");
      if (text == null) return `@import url("${url}")${condition};`;
      return wrapImport(await processCssText(text, url, depth + 1), parseImportCondition(condition));
    });
    return rewriteCssUrls(css, base);
  }

  // @import の後ろの「layer(x) supports(y) media」を分ける
  function parseImportCondition(condition) {
    let rest = condition.trim();
    let layer = null;
    let supports = "";
    const m = rest.match(/^layer(?:\(([^)]*)\))?/i);
    if (m) {
      layer = (m[1] || "").trim();
      rest = rest.slice(m[0].length).trim();
    }
    if (/^supports\(/i.test(rest)) {
      let depth = 0;
      let i = rest.indexOf("(");
      for (; i < rest.length; i++) {
        if (rest[i] === "(") depth++;
        else if (rest[i] === ")" && --depth === 0) break;
      }
      supports = rest.slice(rest.indexOf("(") + 1, i).trim();
      rest = rest.slice(i + 1).trim();
    }
    return { layer, supports, media: rest };
  }

  function wrapImport(css, { layer, supports, media }) {
    if (layer != null) css = `@layer${layer ? " " + layer : ""} {\n${css}\n}`;
    if (supports) css = `@supports (${supports}) {\n${css}\n}`;
    if (media && media.toLowerCase() !== "all") css = `@media ${media} {\n${css}\n}`;
    return css;
  }

  // CSSOM から CSS を書き出す。読めない（別のオリジンの）ときは null
  async function sheetToCss(sheet, depth = 0) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch (_) {
      return null;
    }
    const base = sheet.href || sheet.ownerNode?.baseURI || document.baseURI;
    const parts = [];
    let plain = [];
    const flush = () => {
      if (plain.length) parts.push(rewriteCssUrls(plain.join("\n"), base));
      plain = [];
    };
    for (const rule of rules) {
      if (rule.type === 3 /* CSSRule.IMPORT_RULE */) {
        flush();
        parts.push(importRuleToCss(rule, base, depth));
      } else {
        plain.push(rule.cssText);
      }
    }
    flush();
    return (await Promise.all(parts)).join("\n");
  }

  async function importRuleToCss(rule, base, depth) {
    if (depth >= MAX_IMPORT_DEPTH) return "";
    const url = absolute(rule.href, base);
    let css = rule.styleSheet ? await sheetToCss(rule.styleSheet, depth + 1) : null;
    if (css == null && url) {
      const text = await fetchResource(url, "text");
      if (text != null) css = await processCssText(text, url, depth + 1);
    }
    if (css == null) return url ? `@import url("${url}");` : "";
    return wrapImport(css, {
      layer: rule.layerName ?? null,
      supports: rule.supportsText || "",
      media: rule.media?.mediaText || "",
    });
  }

  // ---------------------------------------------------------------- DOM の写し取り

  const DROP_TAGS = new Set(["script", "noscript", "base", TOAST_TAG]);
  const DROP_LINK_RELS = ["preload", "prefetch", "modulepreload", "preconnect", "dns-prefetch", "prerender", "manifest"];
  const XLINK = "http://www.w3.org/1999/xlink";

  // doc を1つの HTML の文字列にする
  async function serializeDocument(doc) {
    const out = document.implementation.createHTMLDocument("");
    const ctx = { out, base: doc.baseURI, tasks: [] };
    const root = cloneNode(doc.documentElement, ctx);

    let head = root.querySelector(":scope > head");
    if (!head) {
      head = out.createElement("head");
      root.prepend(head);
    }
    const charset = out.createElement("meta");
    charset.setAttribute("charset", "utf-8");
    head.prepend(charset);

    // JS で作られた（adoptedStyleSheets の）CSS
    const adopted = adoptedStyle(doc.adoptedStyleSheets, ctx);
    if (adopted) head.append(adopted);

    await Promise.all(ctx.tasks);
    const doctype = doc.doctype ? `<!DOCTYPE ${doc.doctype.name}>\n` : "";
    return doctype + root.outerHTML;
  }

  function cloneNode(live, ctx) {
    if (live.nodeType === Node.TEXT_NODE) return ctx.out.createTextNode(live.data);
    if (live.nodeType === Node.CDATA_SECTION_NODE) return ctx.out.createTextNode(live.data);
    if (live.nodeType !== Node.ELEMENT_NODE) return null; // コメントなどは捨てる
    return cloneElement(live, ctx);
  }

  function cloneElement(live, ctx) {
    const tag = live.localName;
    if (DROP_TAGS.has(tag)) return null;
    if (tag === "link") return cloneLink(live, ctx);
    if (tag === "style") return cloneStyle(live, ctx);
    if (tag === "meta") {
      const equiv = (live.httpEquiv || "").toLowerCase();
      if (live.hasAttribute("charset") || equiv === "content-type") return null;
      if (equiv === "refresh" || equiv === "content-security-policy") return null;
    }
    if (tag === "template") return ctx.out.importNode(live, true);
    if (tag === "canvas") {
      const img = cloneCanvas(live, ctx);
      if (img) return img;
    }
    // <picture> の <source> は外し、<img> に実際に表示している画像を入れる
    if (tag === "source" && live.parentElement?.localName === "picture") return null;

    // 写し先の文書には custom element の登録がないので、ページの JS は動かない
    const el = ctx.out.importNode(live, false);
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.name)) el.removeAttributeNode(attr);
    }
    fixElement(live, el, ctx);

    // Shadow DOM（閉じたものも chrome.dom で読める）
    const shadow = shadowRootOf(live);
    if (shadow) el.appendChild(cloneShadow(shadow, ctx));

    if (tag !== "textarea") {
      for (const child of live.childNodes) {
        const c = cloneNode(child, ctx);
        if (c) el.appendChild(c);
      }
    }
    return el;
  }

  function fixElement(live, el, ctx) {
    const tag = live.localName;
    const later = (promise, apply) => ctx.tasks.push(promise.then(apply));
    const absAttr = (name) => {
      const v = live.getAttribute(name);
      if (v != null) el.setAttribute(name, absolute(v, ctx.base) ?? v);
    };
    const inlineAttr = (name, url = live.getAttribute(name)) => {
      if (!url || /^(data|#)/i.test(url)) return;
      later(inlineUrl(url, ctx.base), (v) => el.setAttribute(name, v));
    };

    switch (tag) {
      case "img": {
        // いま表示している画像（srcset から選ばれたもの）を src に入れる
        const src = live.currentSrc || live.getAttribute("src");
        ["srcset", "sizes", "loading", "decoding", "crossorigin"].forEach((a) => el.removeAttribute(a));
        if (src) inlineAttr("src", src);
        break;
      }
      case "input": {
        const type = (live.type || "").toLowerCase();
        if (type === "password" || type === "file") el.removeAttribute("value");
        else if (type === "checkbox" || type === "radio") el.toggleAttribute("checked", live.checked);
        else if (type === "image") inlineAttr("src");
        else el.setAttribute("value", live.value);
        break;
      }
      case "textarea":
        el.textContent = live.value;
        break;
      case "option":
        el.toggleAttribute("selected", live.selected);
        break;
      case "a":
      case "area":
        absAttr("href");
        break;
      case "form":
        absAttr("action");
        break;
      case "iframe":
      case "frame": {
        let doc = null;
        try {
          doc = live.contentDocument;
        } catch (_) {}
        if (doc?.documentElement && tag === "iframe") {
          // 同じオリジンなら中身ごと埋め込む
          el.removeAttribute("src");
          later(serializeDocument(doc), (html) => el.setAttribute("srcdoc", html));
        } else {
          absAttr("src");
        }
        break;
      }
      case "video":
        absAttr("src");
        inlineAttr("poster");
        break;
      case "audio":
      case "source":
      case "track":
      case "embed":
        absAttr("src");
        break;
      case "object":
        absAttr("data");
        break;
      case "image": // SVG の <image>
        if (live.hasAttribute("href")) inlineAttr("href");
        if (live.hasAttributeNS(XLINK, "href")) {
          later(inlineUrl(live.getAttributeNS(XLINK, "href"), ctx.base), (v) => el.setAttributeNS(XLINK, "xlink:href", v));
        }
        break;
      case "use": // SVG の <use>。別ファイルを指すものは絶対 URL にする
        for (const [ns, name] of [[null, "href"], [XLINK, "xlink:href"]]) {
          const v = ns ? live.getAttributeNS(ns, "href") : live.getAttribute(name);
          if (v && !v.startsWith("#")) {
            const abs = absolute(v, ctx.base) ?? v;
            ns ? el.setAttributeNS(ns, name, abs) : el.setAttribute(name, abs);
          }
        }
        break;
    }

    if (live.hasAttribute("background")) inlineAttr("background"); // <body background> などの古い書き方

    const style = live.getAttribute("style");
    if (style && /url\(/i.test(style)) {
      later(rewriteCssUrls(style, ctx.base), (v) => el.setAttribute("style", v));
    }
  }

  function cloneLink(live, ctx) {
    const rels = (live.getAttribute("rel") || "").toLowerCase().split(/\s+/);
    if (rels.includes("stylesheet")) {
      const sheet = live.sheet;
      if (live.disabled || sheet?.disabled) return null;
      if (!sheet && rels.includes("alternate")) return null; // 選ばれていない代わりの CSS
      const style = ctx.out.createElement("style");
      if (live.media && live.media !== "all") style.setAttribute("media", live.media);
      const href = live.href;
      ctx.tasks.push(
        (async () => {
          // 元の CSS の文字列を使う。CSSOM から書き出すと、var() を使った一括指定が欠けることがあるため
          // （例：border: var(--w) solid var(--c) の後に border-color を書くと、border の残りが空になる）
          const text = href ? await fetchResource(href, "text") : null;
          let css = text != null ? await processCssText(text, href) : null;
          if (css == null && sheet) css = await sheetToCss(sheet);
          style.textContent = css ?? (href ? `@import url("${href}");` : "");
        })()
      );
      return style;
    }
    if (rels.some((r) => DROP_LINK_RELS.includes(r))) return null;

    const el = ctx.out.importNode(live, false);
    el.removeAttribute("integrity");
    el.removeAttribute("crossorigin");
    const href = live.getAttribute("href");
    if (href) {
      if (rels.some((r) => r.includes("icon"))) {
        ctx.tasks.push(inlineUrl(href, ctx.base).then((v) => el.setAttribute("href", v)));
      } else {
        el.setAttribute("href", absolute(href, ctx.base) ?? href);
      }
    }
    return el;
  }

  function cloneStyle(live, ctx) {
    const style = ctx.out.importNode(live, false);
    // ふつうは中身の文字列を使う（CSSOM からの書き出しは欠けることがあるため。cloneLink を参照）。
    // CSS-in-JS が insertRule でルールを足していて、文字列より CSSOM のほうがルールが多いときだけ CSSOM を使う
    ctx.tasks.push(
      (async () => {
        const text = live.textContent;
        let css = null;
        if (live.sheet && hasRulesNotInText(live.sheet, text)) css = await sheetToCss(live.sheet);
        if (css == null) css = await processCssText(text, ctx.base);
        style.textContent = css;
      })()
    );
    return style;
  }

  function hasRulesNotInText(sheet, text) {
    try {
      const count = (rules) => [...rules].filter((r) => r.type !== 3 /* @import */).length;
      if (!text.trim()) return sheet.cssRules.length > 0;
      const parsed = new CSSStyleSheet();
      parsed.replaceSync(text); // @import は無視されるので、数えるときも除く
      return count(sheet.cssRules) > count(parsed.cssRules);
    } catch (_) {
      return false;
    }
  }

  function cloneCanvas(live, ctx) {
    try {
      const img = ctx.out.createElement("img");
      img.setAttribute("src", live.toDataURL("image/png"));
      for (const name of ["id", "class", "style", "width", "height", "title", "aria-label", "role"]) {
        const v = live.getAttribute(name);
        if (v != null) img.setAttribute(name, v);
      }
      if (!live.hasAttribute("width")) img.setAttribute("width", live.width);
      if (!live.hasAttribute("height")) img.setAttribute("height", live.height);
      return img;
    } catch (_) {
      return null; // 別のオリジンの画像を描いた canvas は読めない
    }
  }

  // chrome.dom は HTMLElement しか受け付けず、SVG の要素や iframe の中の要素（別のウィンドウのもの）では
  // TypeError を投げる。そのときは開いた Shadow DOM だけを読む
  function shadowRootOf(live) {
    try {
      const root = chrome.dom?.openOrClosedShadowRoot?.(live);
      if (root) return root;
    } catch (_) {}
    return live.shadowRoot;
  }

  function cloneShadow(shadow, ctx) {
    const template = ctx.out.createElement("template");
    template.setAttribute("shadowrootmode", shadow.mode === "closed" ? "closed" : "open");
    const adopted = adoptedStyle(shadow.adoptedStyleSheets, ctx);
    if (adopted) template.content.appendChild(adopted);
    for (const child of shadow.childNodes) {
      const c = cloneNode(child, ctx);
      if (c) template.content.appendChild(c);
    }
    return template;
  }

  function adoptedStyle(sheets, ctx) {
    if (!sheets?.length) return null;
    const style = ctx.out.createElement("style");
    ctx.tasks.push(
      Promise.all([...sheets].map((s) => sheetToCss(s))).then((list) => {
        style.textContent = list.filter(Boolean).join("\n");
      })
    );
    return style;
  }

  // ---------------------------------------------------------------- 保存

  // スクロールしないと読み込まれない画像を読ませるため、一度下までスクロールして元の位置に戻す
  function preScroll() {
    const startX = window.scrollX;
    const startY = window.scrollY;
    return new Promise((resolve) => {
      const start = Date.now();
      const step = () => {
        const bottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
        if (bottom || Date.now() - start > 10000) {
          window.scrollTo(startX, startY);
          setTimeout(resolve, 300);
          return;
        }
        window.scrollBy(0, window.innerHeight);
        setTimeout(step, 150);
      };
      step();
    });
  }

  function makeFilename() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(
      d.getMinutes()
    )}${pad(d.getSeconds())}`;
    let name = (document.title || location.hostname || "page")
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    return `${name || "page"}-${stamp}.html`;
  }

  function download(html, filename) {
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    // ページの中には置かずにクリックする（ページの JS にクリックを横取りされないように）
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  function formatSize(bytes) {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  async function main() {
    try {
      toast.set("busy", "画像を読み込み中…");
      await preScroll();
      toast.set("busy", "ページを書き出し中…");

      const savedAt = new Date().toLocaleString("ja-JP");
      const body = await serializeDocument(document);
      const note = `<!-- 保存元: ${location.href.replace(/--/g, "%2D%2D")} （${savedAt}）Save Page as HTML で保存 -->\n`;
      const html = body.startsWith("<!DOCTYPE")
        ? body.replace(/^(<!DOCTYPE[^>]*>\n)/, `$1${note}`)
        : note + body;

      download(html, makeFilename());
      const failed = [...cache.values()].length - (await countOk());
      const size = formatSize(new Blob([html]).size);
      ended = true;
      toast.set("done", failed ? `保存しました（${size}。素材 ${failed} 件は埋め込めず、URL のまま）` : `保存しました（${size}）`);
      toast.closeLater(failed ? 6000 : 3000);
    } catch (err) {
      console.error("[save-page-html]", err);
      ended = true;
      toast.set("error", `保存できませんでした（${err?.message || err}）`);
      toast.closeLater(8000);
    } finally {
      delete window.__savePageHtml;
    }
  }

  async function countOk() {
    const values = await Promise.all(cache.values());
    return values.filter((v) => v != null).length;
  }

  main();
})();
