// Dark mode toggle + system preference, stored in localStorage (no cookies needed).
// Standalone: works on login page too (no dependency on app.js).
"use strict";

const THEME_KEY = "paygate_theme";
const ACCENT_KEY = "paygate_accent";
const DEFAULT_ACCENT = "#059669";

function validAccent(value) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function accentTokens(hex) {
  const value = hex.slice(1);
  const rgb = [0, 2, 4].map(i => parseInt(value.slice(i, i + 2), 16));
  const [r, g, b] = rgb;
  const mix = (target, amount) => "#" + rgb.map(channel => Math.round(channel + (target - channel) * amount).toString(16).padStart(2, "0")).join("");
  const linear = channel => {
    const value = channel / 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  const whiteContrast = 1.05 / (luminance + .05);
  const darkLuminance = 0.0063; // #0b1220
  const darkContrast = (luminance + .05) / (darkLuminance + .05);
  return { base: hex.toLowerCase(), hover: mix(0, .22), soft: `rgba(${r},${g},${b},.16)`, faint: `rgba(${r},${g},${b},.08)`, contrast: whiteContrast >= darkContrast ? "#ffffff" : "#0b1220" };
}

function applyAccent(value, persist = false) {
  const hex = validAccent(value) ? value.toLowerCase() : DEFAULT_ACCENT;
  const tokens = accentTokens(hex);
  const style = document.documentElement.style;
  style.setProperty("--primary", tokens.base);
  style.setProperty("--primary-hover", tokens.hover);
  style.setProperty("--primary-contrast", tokens.contrast);
  style.setProperty("--primary-soft", tokens.soft);
  style.setProperty("--primary-050", tokens.faint);
  document.querySelectorAll("[data-accent]").forEach(el => el.setAttribute("aria-pressed", String(el.dataset.accent.toLowerCase() === hex)));
  const picker = document.getElementById("accentColor");
  const label = document.getElementById("accentColorValue");
  if (picker) picker.value = hex;
  if (label) label.textContent = hex.toUpperCase();
  if (persist) try { localStorage.setItem(ACCENT_KEY, hex); } catch {}
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelectorAll('[data-action="toggle-theme"]').forEach(btn => {
    btn.setAttribute("aria-pressed", String(theme === "dark"));
    btn.title = theme === "dark" ? "Ganti ke mode terang" : "Ganti ke mode gelap";
    btn.setAttribute("aria-label", "Ganti tema terang/gelap");
  });
}

function storedTheme() {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === "dark" || value === "light" ? value : null;
  } catch { return null; }
}

function systemTheme() {
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

let explicitTheme = storedTheme();
applyAccent((() => { try { return localStorage.getItem(ACCENT_KEY); } catch { return null; } })());
applyTheme(explicitTheme || systemTheme());
if (!validAccent((() => { try { return localStorage.getItem(ACCENT_KEY); } catch { return null; } })())) {
  try { localStorage.removeItem(ACCENT_KEY); } catch {}
}

window.addEventListener("storage", event => {
  if (event.key === THEME_KEY) {
    explicitTheme = event.newValue === "dark" || event.newValue === "light" ? event.newValue : null;
    applyTheme(explicitTheme || systemTheme());
  }
  if (event.key === ACCENT_KEY) applyAccent(event.newValue);
});
window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
  if (!explicitTheme) applyTheme(systemTheme());
});

document.addEventListener("click", event => {
  const themeToggle = event.target.closest('[data-action="toggle-theme"]');
  if (themeToggle && !themeToggle.disabled) {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    explicitTheme = next;
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch {}
    return;
  }
  const swatch = event.target.closest("[data-accent]");
  if (swatch && validAccent(swatch.dataset.accent)) applyAccent(swatch.dataset.accent, true);
  if (event.target.closest('[data-action="reset-accent"]')) {
    try { localStorage.removeItem(ACCENT_KEY); } catch {}
    applyAccent(DEFAULT_ACCENT);
  }
});

document.addEventListener("input", event => {
  if (event.target.id === "accentColor" && validAccent(event.target.value)) applyAccent(event.target.value, true);
});

document.addEventListener("DOMContentLoaded", () => {
  let saved = null;
  try { saved = localStorage.getItem(ACCENT_KEY); } catch {}
  applyAccent(saved);
});
