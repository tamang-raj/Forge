(() => {
  "use strict";

  const STORAGE_KEY = "forge.editor.v1";
  const LANGS = ["html", "css", "js"];

  /* ============================================================
     STATE
     ============================================================ */

  let state = {
    html: "",
    css: "",
    js: ""
  };
  let activeLang = "html";
  let autoRun = true;
  let consoleEntries = [];
  let runDebounce = null;

  /* ============================================================
     DOM refs
     ============================================================ */

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const inputs = { html: $("#input-html"), css: $("#input-css"), js: $("#input-js") };
  const highlights = { html: $("#highlight-html"), css: $("#highlight-css"), js: $("#highlight-js") };
  const gutters = { html: $("#gutter-html"), css: $("#gutter-css"), js: $("#gutter-js") };

  const previewFrame = $("#previewFrame");
  const signalBar = $("#signalBar");
  const saveState = $("#saveState");
  const consoleBody = $("#consoleBody");
  const consoleCount = $("#consoleCount");
  const consolePanel = $("#consolePanel");

  /* ============================================================
     SYNTAX HIGHLIGHTING (lightweight regex tokenizers)
     ============================================================ */

  function escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function highlightHTML(src) {
    let s = escapeHtml(src);
    // comments
    s = s.replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="tok-comment">$1</span>');
    // tags with attributes
    s = s.replace(/(&lt;\/?)([a-zA-Z0-9-]+)((?:\s+[a-zA-Z-:]+(?:=(?:"[^"]*"|'[^']*'))?)*)(\s*\/?&gt;)/g,
      (m, open, tag, attrs, close) => {
        let attrHtml = attrs.replace(/([a-zA-Z-:]+)(=)("([^"]*)"|'([^']*)')/g,
          '<span class="tok-attr">$1</span>$2<span class="tok-string">$3</span>');
        return `<span class="tok-punct">${open}</span><span class="tok-tag">${tag}</span>${attrHtml}<span class="tok-punct">${close}</span>`;
      });
    return s;
  }

  function highlightCSS(src) {
    let s = escapeHtml(src);
    s = s.replace(/(\/\*[\s\S]*?\*\/)/g, '<span class="tok-comment">$1</span>');
    s = s.replace(/([.#]?[a-zA-Z0-9_\-&:>,.\s\[\]="'~^$*]+)(\{)/g, (m, sel, brace) => {
      if (sel.includes("<span")) return m;
      return `<span class="tok-selector">${sel}</span><span class="tok-punct">${brace}</span>`;
    });
    s = s.replace(/([a-zA-Z-]+)(\s*:\s*)([^;{}]+)(;?)/g, (m, prop, colon, val, semi) => {
      if (prop.includes("<span")) return m;
      const valHl = val.replace(/(#[0-9a-fA-F]{3,8}|-?\d+\.?\d*(px|em|rem|%|vh|vw|s|deg)?)/g, '<span class="tok-value">$1</span>');
      return `<span class="tok-property">${prop}</span>${colon}${valHl}<span class="tok-punct">${semi}</span>`;
    });
    s = s.replace(/(&quot;[^&]*&quot;|'[^']*')/g, '<span class="tok-string">$1</span>');
    return s;
  }

  const JS_KEYWORDS = /\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|class|extends|new|this|typeof|instanceof|in|of|try|catch|finally|throw|async|await|import|export|default|from|null|undefined|void|delete|yield|static|get|set|super)\b/g;
  const JS_BOOL = /\b(true|false|NaN|Infinity)\b/g;

  function highlightJS(src) {
    let s = escapeHtml(src);
    const tokens = [];
    // Order matters: comments & strings first, protect them
    s = s.replace(/(\/\/[^\n]*)/g, (m) => stash(`<span class="tok-comment">${m}</span>`));
    s = s.replace(/(\/\*[\s\S]*?\*\/)/g, (m) => stash(`<span class="tok-comment">${m}</span>`));
    s = s.replace(/(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, (m) => stash(`<span class="tok-string">${m}</span>`));

    function stash(html) {
      tokens.push(html);
      return `@@TOKEN${tokens.length - 1}@@`;
    }

    s = s.replace(JS_KEYWORDS, '<span class="tok-keyword">$1</span>');
    s = s.replace(JS_BOOL, '<span class="tok-bool">$1</span>');
    s = s.replace(/\b(\d+\.?\d*)\b/g, '<span class="tok-number">$1</span>');
    s = s.replace(/([a-zA-Z_$][\w$]*)(\s*\()/g, '<span class="tok-func">$1</span>$2');

    s = s.replace(/@@TOKEN(\d+)@@/g, (m, i) => tokens[Number(i)]);
    return s;
  }

  const HIGHLIGHTERS = { html: highlightHTML, css: highlightCSS, js: highlightJS };

  /* ============================================================
     EDITOR RENDERING
     ============================================================ */

  function renderLineNumbers(lang) {
    const lineCount = state[lang].split("\n").length;
    const gutter = gutters[lang];
    const current = gutter.children.length;
    if (current === lineCount) return;
    let html = "";
    for (let i = 1; i <= lineCount; i++) html += `<div>${i}</div>`;
    gutter.innerHTML = html;
  }

  function renderHighlight(lang) {
    highlights[lang].innerHTML = HIGHLIGHTERS[lang](state[lang]) + "\n";
  }

  function syncScroll(lang) {
    highlights[lang].scrollTop = inputs[lang].scrollTop;
    highlights[lang].scrollLeft = inputs[lang].scrollLeft;
    gutters[lang].scrollTop = inputs[lang].scrollTop;
  }

  function refreshEditor(lang) {
    renderLineNumbers(lang);
    renderHighlight(lang);
    syncScroll(lang);
  }

  /* ============================================================
     TABS
     ============================================================ */

  function setActiveLang(lang) {
    activeLang = lang;
    $$(".tab").forEach(t => {
      const isActive = t.dataset.lang === lang;
      t.classList.toggle("is-active", isActive);
      t.setAttribute("aria-selected", isActive ? "true" : "false");
    });
    $$(".editor").forEach(e => e.classList.toggle("is-active", e.dataset.lang === lang));
    inputs[lang].focus({ preventScroll: true });
  }

  $$(".tab").forEach(tab => {
    tab.addEventListener("click", () => setActiveLang(tab.dataset.lang));
  });

  /* ============================================================
     TEXTAREA BEHAVIOR
     ============================================================ */

  LANGS.forEach(lang => {
    const el = inputs[lang];
    el.value = state[lang];

    el.addEventListener("input", () => {
      state[lang] = el.value;
      refreshEditor(lang);
      markUnsaved();
      persist();
      if (autoRun) scheduleRun();
    });

    el.addEventListener("scroll", () => syncScroll(lang));

    el.addEventListener("keydown", (e) => {
      if (e.key === "Tab") {
        e.preventDefault();
        const start = el.selectionStart, end = el.selectionEnd;
        el.value = el.value.slice(0, start) + "  " + el.value.slice(end);
        el.selectionStart = el.selectionEnd = start + 2;
        el.dispatchEvent(new Event("input"));
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        runNow();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        exportSingleFile();
      }
      // auto-close brackets/quotes
      const pairs = { "(": ")", "[": "]", "{": "}", '"': '"', "'": "'", "`": "`" };
      if (pairs[e.key] && el.selectionStart === el.selectionEnd) {
        e.preventDefault();
        const pos = el.selectionStart;
        el.value = el.value.slice(0, pos) + e.key + pairs[e.key] + el.value.slice(pos);
        el.selectionStart = el.selectionEnd = pos + 1;
        el.dispatchEvent(new Event("input"));
      }
    });
  });

  /* ============================================================
     PERSISTENCE
     ============================================================ */

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, autoRun }));
      setTimeout(markSaved, 350);
    } catch (err) {
      console.warn("Could not persist to localStorage", err);
    }
  }

  function loadPersisted() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      LANGS.forEach(l => { if (typeof parsed[l] === "string") state[l] = parsed[l]; });
      if (typeof parsed.autoRun === "boolean") autoRun = parsed.autoRun;
      return true;
    } catch {
      return false;
    }
  }

  function markUnsaved() { saveState.textContent = "editing…"; saveState.classList.add("is-unsaved"); }
  function markSaved() { saveState.textContent = "saved"; saveState.classList.remove("is-unsaved"); }

  /* ============================================================
     RUN / PREVIEW
     ============================================================ */

  const CONSOLE_BRIDGE = `
    <script>
      (function() {
        const send = (level, args) => {
          try {
            const payload = args.map(a => {
              if (a instanceof Error) return a.name + ": " + a.message;
              if (typeof a === "object") { try { return JSON.stringify(a); } catch { return String(a); } }
              return String(a);
            });
            parent.postMessage({ __forgeConsole: true, level, payload }, "*");
          } catch (e) {}
        };
        ["log","warn","error","info"].forEach(level => {
          const original = console[level];
          console[level] = function(...args) { send(level, args); original.apply(console, args); };
        });
        window.addEventListener("error", (e) => send("error", [e.message + " (" + e.filename + ":" + e.lineno + ")"]));
        window.addEventListener("unhandledrejection", (e) => send("error", ["Unhandled promise rejection: " + e.reason]));
      })();
    <\/script>
  `;

  function buildDocument() {
    return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8">
<style>${state.css}</style>
${CONSOLE_BRIDGE}
</head>
<body>
${state.html}
<script>${state.js}<\/script>
</body>
</html>`;
  }

  function runNow() {
    previewFrame.srcdoc = buildDocument();
    clearConsole(true);
    signalBar.classList.remove("is-running");
    void signalBar.offsetWidth; // restart animation
    signalBar.classList.add("is-running");
  }

  function scheduleRun() {
    clearTimeout(runDebounce);
    runDebounce = setTimeout(runNow, 450);
  }

  $("#runBtn").addEventListener("click", runNow);
  $("#refreshBtn").addEventListener("click", runNow);
  $("#autoRunToggle").addEventListener("change", (e) => {
    autoRun = e.target.checked;
    persist();
    if (autoRun) runNow();
  });

  $("#popoutBtn").addEventListener("click", () => {
    const win = window.open("", "_blank");
    if (win) { win.document.open(); win.document.write(buildDocument()); win.document.close(); }
  });

  /* ============================================================
     CONSOLE PANEL
     ============================================================ */

  const ICONS = {
    log: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M8 12h8M8 8h8M8 16h5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
    info: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M12 11v5M12 8v.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
    warn: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M12 3l10 18H2L12 3z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v4M12 17v.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
    error: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M15 9l-6 6M9 9l6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`
  };

  function addConsoleEntry(level, payload) {
    consoleEntries.push({ level, payload, time: new Date() });
    renderConsole();
  }

  function renderConsole() {
    if (consoleEntries.length === 0) {
      consoleBody.innerHTML = `<div class="console__empty">No output yet — logs, warnings and errors from your code will show up here.</div>`;
      consoleCount.hidden = true;
      return;
    }
    consoleCount.hidden = false;
    consoleCount.textContent = consoleEntries.length;
    consoleBody.innerHTML = consoleEntries.map(entry => {
      const icon = ICONS[entry.level] || ICONS.log;
      const time = entry.time.toLocaleTimeString([], { hour12: false });
      const text = escapeHtml(entry.payload.join(" "));
      return `<div class="console__row console__row--${entry.level}">
        <span class="console__icon">${icon}</span>
        <span class="console__time">${time}</span>
        <span>${text}</span>
      </div>`;
    }).join("");
    consoleBody.scrollTop = consoleBody.scrollHeight;
  }

  function clearConsole(silent) {
    consoleEntries = [];
    if (!silent) renderConsole(); else renderConsole();
  }

  window.addEventListener("message", (e) => {
    const data = e.data;
    if (data && data.__forgeConsole) {
      addConsoleEntry(data.level, data.payload);
    }
  });

  $("#consoleToggle").addEventListener("click", () => {
    const isOpen = consolePanel.classList.toggle("is-open");
    $("#consoleToggle").setAttribute("aria-expanded", isOpen ? "true" : "false");
  });
  $("#consoleClear").addEventListener("click", (e) => {
    e.stopPropagation();
    clearConsole();
  });

  /* ============================================================
     EXPORT MENU
     ============================================================ */

  function toggleMenu(btn, menu, open) {
    const show = open ?? menu.hidden;
    menu.hidden = !show;
    btn.setAttribute("aria-expanded", show ? "true" : "false");
  }

  const exportBtn = $("#exportBtn");
  const exportMenu = $("#exportMenu");
  exportBtn.addEventListener("click", () => toggleMenu(exportBtn, exportMenu));

  function download(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  function exportSingleFile() {
    download("forge-export.html", buildDocument(), "text/html");
  }

  exportMenu.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-export]");
    if (!btn) return;
    if (btn.dataset.export === "single") {
      exportSingleFile();
    } else {
      download("index.html", `<!DOCTYPE html>\n<html>\n<head>\n<meta charset="UTF-8">\n<link rel="stylesheet" href="style.css">\n</head>\n<body>\n${state.html}\n<script src="script.js"><\/script>\n</body>\n</html>`, "text/html");
      download("style.css", state.css, "text/css");
      download("script.js", state.js, "text/javascript");
    }
    toggleMenu(exportBtn, exportMenu, false);
  });

  document.addEventListener("click", (e) => {
    if (!exportBtn.contains(e.target) && !exportMenu.contains(e.target)) toggleMenu(exportBtn, exportMenu, false);
  });

  /* ============================================================
     RESIZABLE DIVIDER
     ============================================================ */

  const divider = $("#divider");
  const editorPane = $("#editorPane");
  const workspaceEl = $("#workspace");

  let dragging = false;
  divider.addEventListener("mousedown", () => { dragging = true; document.body.style.userSelect = "none"; });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const rect = workspaceEl.getBoundingClientRect();
    let pct = ((e.clientX - rect.left) / rect.width) * 100;
    pct = Math.min(75, Math.max(25, pct));
    editorPane.style.width = pct + "%";
  });
  window.addEventListener("mouseup", () => { dragging = false; document.body.style.userSelect = ""; });

  divider.addEventListener("keydown", (e) => {
    const rect = workspaceEl.getBoundingClientRect();
    let current = editorPane.getBoundingClientRect().width / rect.width * 100;
    if (e.key === "ArrowLeft") current -= 2;
    if (e.key === "ArrowRight") current += 2;
    current = Math.min(75, Math.max(25, current));
    editorPane.style.width = current + "%";
  });

  /* ============================================================
     MOBILE VIEW SWITCH
     ============================================================ */

  $$(".mobile-switch__btn").forEach(btn => {
    btn.addEventListener("click", () => {
      $$(".mobile-switch__btn").forEach(b => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      workspaceEl.classList.toggle("view-preview", btn.dataset.view === "preview");
    });
  });

  /* ============================================================
     INIT
     ============================================================ */

  function init() {
    loadPersisted();
    LANGS.forEach(l => { inputs[l].value = state[l]; refreshEditor(l); });
    $("#autoRunToggle").checked = autoRun;
    setActiveLang("html");
    renderConsole();
    runNow();
  }

  init();
})();
