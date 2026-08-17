import { renderAdminShell } from './shell.js';
import { getSiteContent, upsertSiteContent, deleteSiteContent } from '../../lib/adminApi.js';
import { formatDateTime, escapeHtml } from '../../lib/format.js';

const AREAS = ['public', 'client', 'employee', 'admin', 'irs'];
// Sections lues par la page d'accueil publique (src/pages/public/home.js) :
// hero (objet), key_stats (objet {stats:[...]}), service_catalog (liste),
// city_news (liste), top10 (liste), quote (liste), testimonial (liste).
const KNOWN_SECTIONS = ['hero', 'key_stats', 'service_catalog', 'city_news', 'top10', 'quote', 'testimonial', 'project_showcase'];

export async function renderAdminCms(app, profile) {
  const { content } = await renderAdminShell(app, profile, 'cms');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  function groupByArea(rows) {
    const groups = {};
    for (const r of rows) {
      if (!groups[r.area]) groups[r.area] = [];
      groups[r.area].push(r);
    }
    return groups;
  }

  async function draw() {
    const rows = await getSiteContent().catch(() => []);
    const grouped = groupByArea(rows);

    content.innerHTML = `
      <h1 style="margin-bottom:6px;">Contenu du site</h1>
      <p class="muted" style="margin-bottom:20px;">
        CMS générique pour la page d'accueil publique et les autres interfaces. Chaque section est un bloc JSON libre ;
        les clés lues par la page d'accueil sont : <code>${KNOWN_SECTIONS.join('</code>, <code>')}</code>.
      </p>

      ${AREAS.filter((a) => grouped[a]?.length)
        .map(
          (area) => `
        <h3 style="margin-bottom:12px;">${area}</h3>
        <div class="card" style="margin-bottom:20px;">
          ${grouped[area]
            .sort((a, b) => a.sort_order - b.sort_order)
            .map(
              (r) => `
            <div style="padding:16px 0; border-bottom:1px solid var(--card-border);">
              <div class="flex justify-between items-center" style="margin-bottom:10px;">
                <div>
                  <strong>${escapeHtml(r.section_key)}</strong>
                  <span class="muted" style="font-size:12px; margin-left:8px;">maj ${formatDateTime(r.updated_at)}</span>
                </div>
                <div class="flex gap-sm items-center">
                  <label class="flex items-center gap-sm" style="font-size:12px; font-weight:400;">
                    <input type="checkbox" class="content-active" data-id="${r.id}" ${r.is_active ? 'checked' : ''} /> actif
                  </label>
                  <input type="number" class="content-sort" data-id="${r.id}" value="${r.sort_order}" style="width:70px; padding:4px 8px; font-size:12px;" title="Ordre" />
                  <button class="btn btn-ghost content-delete" data-id="${r.id}" style="padding:4px 8px; font-size:12px; color:var(--status-danger);">Supprimer</button>
                </div>
              </div>
              <textarea class="content-json" data-id="${r.id}" rows="6" style="width:100%; font-family:monospace; font-size:12px;">${escapeHtml(JSON.stringify(r.content, null, 2))}</textarea>
              <div class="content-error text-danger" data-id="${r.id}" style="font-size:12px; margin-top:6px; display:none;"></div>
              <button class="btn btn-secondary content-save" data-id="${r.id}" data-area="${r.area}" data-key="${escapeHtml(r.section_key)}" style="margin-top:10px;">Enregistrer</button>
            </div>
          `
            )
            .join('')}
        </div>
      `
        )
        .join('')}

      <h3 style="margin-bottom:12px;">Ajouter une section</h3>
      <div class="card">
        <div class="grid" style="grid-template-columns: 1fr 1fr 1fr; gap:10px;">
          <div class="field" style="margin:0;">
            <label>Zone</label>
            <select id="new-area">${AREAS.map((a) => `<option value="${a}">${a}</option>`).join('')}</select>
          </div>
          <div class="field" style="margin:0;">
            <label>Clé de section</label>
            <input type="text" id="new-key" placeholder="ex: hero" />
          </div>
          <div class="field" style="margin:0;">
            <label>Ordre</label>
            <input type="number" id="new-sort" value="0" />
          </div>
        </div>
        <div class="field">
          <label>Contenu (JSON)</label>
          <textarea id="new-content" rows="4" style="width:100%; font-family:monospace; font-size:12px;">{}</textarea>
        </div>
        <div id="new-error" class="text-danger" style="font-size:13px; margin-bottom:10px; display:none;"></div>
        <button id="new-submit" class="btn btn-primary">Ajouter</button>
      </div>
    `;

    content.querySelectorAll('.content-save').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        const errorEl = content.querySelector(`.content-error[data-id="${id}"]`);
        errorEl.style.display = 'none';
        const textarea = content.querySelector(`.content-json[data-id="${id}"]`);
        const isActive = content.querySelector(`.content-active[data-id="${id}"]`).checked;
        const sortOrder = parseInt(content.querySelector(`.content-sort[data-id="${id}"]`).value, 10) || 0;
        try {
          const parsed = JSON.parse(textarea.value);
          await upsertSiteContent({
            id,
            area: btn.getAttribute('data-area'),
            sectionKey: btn.getAttribute('data-key'),
            content: parsed,
            sortOrder,
            isActive,
          });
          await draw();
        } catch (err) {
          errorEl.textContent = err.message || 'JSON invalide.';
          errorEl.style.display = 'block';
        }
      });
    });

    content.querySelectorAll('.content-delete').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Supprimer cette section de contenu ?')) return;
        try { await deleteSiteContent(btn.getAttribute('data-id')); await draw(); }
        catch (err) { alert(err.message || 'Erreur.'); }
      });
    });

    document.getElementById('new-submit').addEventListener('click', async () => {
      const errorEl = document.getElementById('new-error');
      errorEl.style.display = 'none';
      const area = document.getElementById('new-area').value;
      const sectionKey = document.getElementById('new-key').value.trim();
      const sortOrder = parseInt(document.getElementById('new-sort').value, 10) || 0;
      const rawContent = document.getElementById('new-content').value;
      if (!sectionKey) {
        errorEl.textContent = 'Veuillez renseigner une clé de section.';
        errorEl.style.display = 'block';
        return;
      }
      try {
        const parsed = JSON.parse(rawContent);
        await upsertSiteContent({ area, sectionKey, content: parsed, sortOrder, isActive: true });
        await draw();
      } catch (err) {
        errorEl.textContent = err.message || 'JSON invalide.';
        errorEl.style.display = 'block';
      }
    });
  }

  await draw();
}
