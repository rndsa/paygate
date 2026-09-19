import ejs from "ejs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWS = path.join(__dirname, "..", "..", "views");

/**
 * Render halaman: render konten dulu, lalu bungkus dgn layout.ejs.
 * Semua data (csrfToken, user, active, title) diteruskan.
 */
export async function renderPage(res, page, data = {}) {
  const contentFile = path.join(VIEWS, "pages", `${page}.ejs`);
  const html = await ejs.renderFile(contentFile, { ...res.app.locals, ...res.locals, ...data });
  return res.render("layout", { ...res.locals, ...data, body: html });
}
