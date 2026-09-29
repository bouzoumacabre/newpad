// Contrôle du moteur de NEW AI : node src/apps/ai/guide.check.mjs
import assert from 'node:assert/strict';
import { repondre } from './guide.js';

const app = (slug, name, description, access_level = 'client') =>
  ({ slug, name, description, route: '/' + slug, access_level, is_enabled: true });
const registre = [
  app('bank', 'Newman Bank', 'Banque privée de la ville', 'guest'),
  app('work', 'NewWork', 'Réseau professionnel et emploi'),
  app('doc', 'NewDoc', 'Portail médical'),
  app('luxury', 'Concess Luxury', 'Concession automobile'),
  app('gov', 'NewGov', 'Portail gouvernemental'),
  app('dark', 'NewDark', 'Espace clandestin', 'restricted'),
  app('radio', 'LS Radio', 'Station de radio locale'),
];
const cible = (q) => repondre(q, registre).apps.map((a) => a.name);

assert.deepEqual(cible('Comment faire un VIREMENT ?'), ['Newman Bank']);
assert.deepEqual(cible('je cherche un job'), ['NewWork']);
assert.deepEqual(cible('où acheter une voiture'), ['Concess Luxury']);
assert.deepEqual(cible('il me faut un certificat médical'), ['NewDoc']);
assert.deepEqual(cible('refaire mon permis'), ['NewGov']);
// « or » ne se déclenche pas dans « ordinateur ».
assert.deepEqual(cible('mon ordinateur'), []);
// Une application restreinte n'est jamais révélée, même par son nom.
assert.deepEqual(cible('comment accéder à NewDark, espace clandestin ?'), []);
// Une application ajoutée par l'admin, sans mots-clés, se trouve par son nom
// ou sa description.
assert.deepEqual(cible('la radio de la ville'), ['LS Radio']);
// Questions générales.
assert.match(repondre('Bonjour', registre).texte, /Bonjour/);
assert.match(repondre('mot de passe oublié', registre).texte, /Mot de passe oublié/);
assert.deepEqual(cible('je veux ouvrir un compte'), ['Newman Bank']);
assert.match(repondre('xyz', registre).texte, /pas trouvé/);

console.log('guide NEW AI : OK');
