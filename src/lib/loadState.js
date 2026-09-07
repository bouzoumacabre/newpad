// ============================================================================
// NEWPAD — Chargement de données avec échec visible
// ============================================================================
// Motivation : l'application entière utilisait le motif `.catch(() => [])` sur
// chaque appel de données (130 occurrences). Conséquence : un écran affiche
// exactement le même état vide qu'une requête réussie sans résultat et qu'une
// requête qui a échoué (réseau coupé, RLS mal réglée, colonne inexistante...).
// L'utilisateur ne peut pas faire la différence, et le développeur non plus.
//
// C'est précisément ce qui a masqué trois bugs réels pendant des semaines :
//   - historique des virements du client (tri sur `created_at`, colonne
//     inexistante sur `transfers` — la vraie colonne est `requested_at`) ;
//   - demandes d'achat de lingot à la banque (même cause) ;
//   - demandes d'achat sur le marché de revente (même cause).
// Chacun renvoyait une erreur PostgREST parfaitement explicite, avalée
// silencieusement, et l'écran affichait « Aucun virement pour l'instant ».
//
// `loadAll` conserve le comportement pratique (un échec ne fait pas tomber
// tout l'écran, on garde une valeur de repli) mais journalise l'erreur en
// console ET signale à l'écran appelant qu'il doit prévenir l'utilisateur.
// ============================================================================

/**
 * Charge un ensemble de promesses nommées sans jamais rejeter.
 * @param {Record<string, {promise: Promise<any>, fallback?: any}>} tasks
 * @returns {Promise<{data: Record<string, any>, errors: Array<{key: string, error: any}>}>}
 */
export async function loadAll(tasks) {
  const keys = Object.keys(tasks);
  const settled = await Promise.all(
    keys.map((key) => {
      const task = tasks[key];
      const promise = task && typeof task.then === 'function' ? task : task.promise;
      const fallback = task && typeof task.then === 'function' ? [] : task.fallback;
      return Promise.resolve(promise).then(
        (value) => ({ key, ok: true, value }),
        (error) => {
          console.error(`[newpad] échec de chargement « ${key} » :`, error?.message || error, error);
          return { key, ok: false, error, value: fallback === undefined ? [] : fallback };
        }
      );
    })
  );

  const data = {};
  const errors = [];
  for (const r of settled) {
    data[r.key] = r.value;
    if (!r.ok) errors.push({ key: r.key, error: r.error });
  }
  return { data, errors };
}

/**
 * Bandeau à insérer en haut d'un écran quand au moins un chargement a échoué.
 * Volontairement discret et non bloquant : le reste de l'écran reste utilisable.
 * @param {Array<{key: string, error: any}>} errors
 * @returns {string} HTML (chaîne vide si aucun échec)
 */
export function loadErrorBanner(errors) {
  if (!errors || !errors.length) return '';
  return `
    <div class="card card-tight" style="border-color: var(--danger, #c0392b); margin-bottom:16px;">
      <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
        <span style="font-size:16px;">⚠</span>
        <span style="flex:1; min-width:200px;">
          Certaines données n'ont pas pu être chargées. Ce qui s'affiche ci-dessous est peut-être incomplet.
        </span>
        <button class="btn btn-secondary" style="font-size:12px; padding:4px 10px;"
          onclick="window.location.reload();">Réessayer</button>
      </div>
    </div>
  `;
}

// ----------------------------------------------------------------------------
// `swallow` — le repli, mais jamais en silence
// ----------------------------------------------------------------------------
// `loadAll` est le bon outil quand on réécrit un écran. Mais 149 appels
// dispersés dans 44 fichiers utilisaient encore `.catch(() => [])` : un écran
// vide y signifie indifféremment « aucun résultat » ou « la requête a échoué ».
// Les réécrire tous d'un coup serait un chantier risqué pour un gain de forme.
//
// `swallow` garde donc exactement le même comportement — même repli, même flux
// d'exécution, aucune exception propagée — mais l'échec est journalisé en
// console avec le nom de l'appel, et enregistré pour que la coquille commune
// puisse en avertir l'utilisateur d'un seul endroit.
//
//     getMyAccounts().catch(() => [])            // avant : muet
//     getMyAccounts().catch(() => [])   // après : tracé

const echecs = [];
const abonnes = new Set();

export function swallow(nom, repli = []) {
  return (error) => {
    console.error(`[newpad] échec de chargement « ${nom} » :`, error?.message || error, error);
    echecs.push({ nom, message: error?.message || String(error), at: Date.now() });
    for (const fn of abonnes) {
      try { fn(echecs.length); } catch (_) { /* un abonné défaillant n'empêche rien */ }
    }
    return repli;
  };
}

export function loadFailureCount() {
  return echecs.length;
}

export function loadFailures() {
  return echecs.slice();
}

export function clearLoadFailures() {
  echecs.length = 0;
  for (const fn of abonnes) {
    try { fn(0); } catch (_) { /* idem */ }
  }
}

// La coquille s'abonne pour afficher un indicateur dès le premier échec, quel
// que soit l'écran qui l'a rencontré.
export function onLoadFailure(fn) {
  abonnes.add(fn);
  return () => abonnes.delete(fn);
}
