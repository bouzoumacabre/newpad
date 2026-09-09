// ============================================================================
// NEWPAD — porte d'entrée de Newman Bank depuis la tablette
// ============================================================================
// L'icône « Newman Bank » du lanceur pointe sur une route unique, `/bank`. Elle
// ne peut pas pointer directement sur `/client` ou `/employee` : le registre
// d'applications est commun à tous les joueurs, et chacun n'a accès qu'à
// l'interface de son propre rôle. C'est donc ici, et seulement ici, que le rôle
// est traduit en écran — les 81 routes bancaires existantes ne bougent pas.

import { navigate } from '../../lib/router.js';

const ECRAN_PAR_ROLE = {
  prospect: '/prospect',
  client: '/client',
  employee: '/employee',
  admin: '/admin',
  irs: '/irs',
};

export function enterBank(profile) {
  navigate(ECRAN_PAR_ROLE[profile?.role] || '/bank/home');
}
