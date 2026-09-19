/* PayGate UI helpers */
(function () {
  "use strict";

  // Toast
  function toast(msg, type = "info") {
    let cont = document.querySelector(".toast-container");
    if (!cont) {
      cont = document.createElement("div");
      cont.className = "toast-container";
      document.body.appendChild(cont);
    }
    const el = document.createElement("div");
    el.className = "toast " + type;
    el.textContent = msg;
    el.setAttribute("role", type === "error" ? "alert" : "status");
    cont.appendChild(el);
    setTimeout(() => { el.style.opacity = "0"; }, 3200);
    setTimeout(() => el.remove(), 3600);
  }

  // CSRF token: baca cookie paygate_csrf
  function csrfToken() {
    const m = document.cookie.match(/(?:^|;\s*)paygate_csrf=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  }

  async function api(url, opts = {}) {
    const headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    if (opts.method && opts.method !== "GET") headers["X-CSRF-Token"] = csrfToken();
    const res = await fetch(url, Object.assign({}, opts, { headers, credentials: "same-origin" }));
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
      const message = [data?.detail, data?.error, data?.message].find(value => typeof value === "string" && value.trim());
      const error = new Error(message?.slice(0, 1000) || "Permintaan belum berhasil diproses. Coba kembali nanti atau hubungi administrator.");
      if (typeof data?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(data.code)) error.code = data.code;
      if (Number.isSafeInteger(data?.retry_at) && data.retry_at > Date.now() && data.retry_at <= 8640000000000000) {
        error.retry_at=data.retry_at;
        error.message+=" Tunggu sampai "+new Date(data.retry_at).toLocaleString("id-ID")+"; tidak ada pengulangan otomatis.";
      }
      const raw = data?.diagnostic, diagnostic = {};
      if (typeof raw?.id === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(raw.id)) diagnostic.id = raw.id;
      if (["otp_request", "otp_verify", "merchant_discovery", "local_validation", "reauth", "cooldown", "attempt_validation", "otp_validation", "merchant_selection", "merchant_save"].includes(raw?.stage)) diagnostic.stage = raw.stage;
      if (Number.isInteger(raw?.provider_status) && raw.provider_status >= 100 && raw.provider_status <= 599) diagnostic.provider_status = raw.provider_status;
      else if (raw?.provider_status === null) diagnostic.provider_status = null;
      if (Object.keys(diagnostic).length) {
        error.diagnostic = Object.freeze(diagnostic);
        // Developer diagnostics stay in console; the dialog shows actionable client copy.
        // Never log request options/URL, form fields, raw response, cookies or message.
        const log = {event:"api_request_failed", http_status:res.status, ...diagnostic};
        if (["FORBIDDEN","UNSUPPORTED","INVALID","REAUTH","COOLDOWN","EXPIRED","BUSY","CHALLENGE","AUTH_REJECTED","PHONE_REJECTED","PROVIDER_ERROR","REQUEST_REJECTED","RATE_LIMITED","BUSINESS_REJECTED","BAD_RESPONSE","NETWORK","NO_MERCHANT","MULTI_OUTLET","SCOPE_CHANGED","SAVE_FAILED"].includes(error.code)) log.code = error.code;
        console.warn("[PayGate] Request failed", log);
      }
      throw error;
    }
    return data;
  }

  function fmtRupiah(n) {
    return "Rp " + Number(n || 0).toLocaleString("id-ID");
  }
  function fmtDate(ms) {
    return ms ? new Date(ms).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" }) : "-";
  }
  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML.replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  }
  async function copyText(text, label) {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
      toast(label || "Tersalin!", "success");
    } catch { toast("Gagal menyalin. Pilih teks lalu salin manual.", "error"); }
  }

  // ---- Input formatting: phone (+62) & numeric (digits only) ----
  // Explicit data attributes only; no inline handlers.
  function digitsOnly(value) {
    return String(value == null ? "" : value).replace(/[^0-9]+/g, "");
  }

  // Normalize an Indonesian mobile number to +62 form: 0xxx -> +62xxx, 62xxx -> +62xxx, 8xxx -> +62xxx.
  function formatPhoneID(raw) {
    let d = digitsOnly(raw);
    if (d.startsWith("62")) d = d.slice(2);
    else if (d.startsWith("0")) d = d.slice(1);
    return d ? "+62" + d : "";
  }

  // Local part only, for fields that already show a static "+62" prefix:
  // strips a leading 0/62 so a pasted "0812..." or "62812..." works unchanged.
  function formatPhoneLocal(raw) {
    let d = digitsOnly(raw);
    if (d.startsWith("62")) d = d.slice(2);
    else if (d.startsWith("0")) d = d.slice(1);
    return d;
  }

  function caretToEnd(el) {
    try { el.setSelectionRange(el.value.length, el.value.length); } catch { /* not a text input */ }
  }

  function applyDigits(el) {
    const clean = digitsOnly(el.value);
    if (clean !== el.value) { el.value = clean; caretToEnd(el); }
  }

  function applyPhone(el, { optional = false } = {}) {
    if (optional) {
      // Leave emails/usernames untouched once letters appear.
      if (/\p{L}/u.test(el.value)) { el.dataset.phoneMode = "off"; return; }
      if (el.dataset.phoneMode === "off") return;
      if (el.value.trim() === "") return;
    }
    const formatted = formatPhoneID(el.value);
    if (formatted !== el.value) { el.value = formatted; caretToEnd(el); }
  }

  function applyPhoneLocal(el) {
    const clean = formatPhoneLocal(el.value);
    if (clean !== el.value) { el.value = clean; caretToEnd(el); }
  }

  function formatField(el) {
    const mode = el.dataset.format;
    if (mode === "digits") applyDigits(el);
    else if (mode === "phone") applyPhone(el);
    else if (mode === "phone-local") applyPhoneLocal(el);
    else if (mode === "phone-optional") applyPhone(el, { optional: true });
  }

  document.addEventListener("input", event => {
    const el = event.target;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (el.dataset.format) formatField(el);
    }
  });
  document.addEventListener("blur", event => {
    const el = event.target;
    if (el instanceof HTMLInputElement && el.dataset.format === "phone" && el.value) applyPhone(el);
  }, true);

  function openModal(id) {
    const dialog = document.getElementById(id);
    if (!dialog.open) {
      dialog._opener = document.activeElement;
      dialog.showModal();
    }
  }
  function closeModal(id) { document.getElementById(id).close(); }
  document.querySelectorAll("dialog").forEach(dialog => {
    dialog.addEventListener("close", () => {
      // A completed request may have opened the next dialog already.
      if (document.querySelector("dialog[open]")) return;
      const opener = dialog._opener;
      const replacement = opener?.dataset.action && [...document.querySelectorAll("[data-action]")]
        .find(el => el.dataset.action === opener.dataset.action && el.dataset.id === opener.dataset.id);
      (opener?.isConnected ? opener : replacement)?.focus();
    });
    dialog.addEventListener("keydown", event => {
      if (event.key !== "Tab") return;
      const controls = [...dialog.querySelectorAll('button, input, select, textarea, a[href], [tabindex="0"]')]
        .filter(el => !el.disabled && el.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first?.focus();
      }
    });
  });

  function closeMenu({ restoreFocus = false } = {}) {
    document.getElementById("sidebar")?.classList.remove("open");
    document.getElementById("sidebarScrim")?.classList.remove("visible");
    document.getElementById("sidebarScrim")?.setAttribute("tabindex", "-1");
    document.querySelector("main")?.removeAttribute("inert");
    const burger = document.querySelector(".burger");
    burger?.setAttribute("aria-expanded", "false");
    if (restoreFocus) burger?.focus();
  }

  function openMenu(el) {
    document.getElementById("sidebar")?.classList.add("open");
    document.getElementById("sidebarScrim")?.classList.add("visible");
    document.getElementById("sidebarScrim")?.removeAttribute("tabindex");
    document.querySelector("main")?.setAttribute("inert", "");
    el.setAttribute("aria-expanded", "true");
    // `inert` immediately clears focus from the burger because it lives in main.
    document.activeElement?.blur();
    const firstMenuTarget = document.querySelector(".sidebar .nav-item.active") || document.querySelector(".sidebar .nav-item");
    firstMenuTarget?.focus({ preventScroll: true });
  }

  // Explicit action maps only; data attributes never contain executable code.
  function bindActions(actions) {
    document.addEventListener("click", event => {
      const el = event.target.closest("[data-action]");
      if (el && !el.disabled && Object.hasOwn(actions, el.dataset.action)) actions[el.dataset.action](el);
    });
  }
  bindActions({
    "toggle-menu": el => {
      if (document.getElementById("sidebar")?.classList.contains("open")) closeMenu({ restoreFocus: true });
      else openMenu(el);
    },
    "close-menu": () => closeMenu({ restoreFocus: true }),
    "close-modal": el => closeModal(el.dataset.modal),
    "copy": el => copyText(document.getElementById(el.dataset.target).textContent)
  });
  document.querySelectorAll(".sidebar .nav-item").forEach(el => el.addEventListener("click", () => closeMenu()));
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && document.getElementById("sidebar")?.classList.contains("open")) {
      event.preventDefault();
      closeMenu({ restoreFocus: true });
    }
  });
  window.matchMedia("(min-width: 769px)").addEventListener?.("change", event => {
    if (event.matches) closeMenu();
  });
  const icon = document.querySelector(".nav-item.active svg");
  if (icon) document.getElementById("pageIcon")?.appendChild(icon.cloneNode(true));

  window.PayGate = { openModal, closeModal, bindActions, toast, api, csrfToken, fmtRupiah, fmtDate, esc, copyText, digitsOnly, formatPhoneID, formatPhoneLocal, formatField };
})();
