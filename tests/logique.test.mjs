// Logique de l'app (js/app.js chargé dans Node, vraie base SQLite en mémoire).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chargerApp } from './charger-app.mjs';

const app = await chargerApp();
// Les tableaux/objets créés dans l'app viennent d'un autre « monde » JS :
// on les recopie avant de les comparer.
const js = v => JSON.parse(JSON.stringify(v));

test('montants saisis → centimes', () => {
  assert.equal(app.parseMontantC('12,50'), 1250);
  assert.equal(app.parseMontantC(' 1 234,5 '), 123450);
  assert.equal(app.parseMontantC('-0,1'), -10);
  assert.equal(app.parseMontantC('abc'), null);
  assert.equal(app.parseMontantC(''), null);
});

test('dates saisies JJ/MM/AA → ISO', () => {
  assert.equal(app.frToISO('03/02/2026'), '2026-02-03');
  assert.equal(app.isoToFr('2026-02-03'), '03/02/2026');
});

test('import QIF : dates, montants, statuts, ventilations', () => {
  assert.equal(app.qifParseDate('31/12/25'), '2025-12-31');
  assert.equal(app.qifParseDate("1/2'2024"), '2024-02-01');
  assert.equal(app.qifParseDate('12/31/2024'), '2024-12-31'); // mois/jour inversés reconnus
  assert.equal(app.qifParseDate('n/importe'), null);
  assert.equal(app.qifParseAmount('-1,234.56'), -123456);
  assert.equal(app.qifParseAmount('-45,90'), -4590);

  const ops = js(app.parseQIF([
    '!Account', 'NCompte courant', '^',
    '!Type:Bank',
    'D05/01/2026', 'T-45,90', 'CX', 'PBoulangerie', 'LAlimentation:Pain', 'Mcroissants', '^',
    'D06/01/2026', 'T-100,00', 'C*', 'PSupermarché', 'SAlimentation', '$-70,00', 'SMaison', 'Eampoules', '$-30,00', '^',
    'D07/01/2026', 'PSans montant', '^',
  ].join('\r\n')));
  assert.equal(ops.length, 2, 'la transaction sans montant est ignorée');
  assert.deepEqual(ops[0], { date: '2026-01-05', montant: -4590, statut: 'rapproche', tiers: 'Boulangerie', categorie: 'Alimentation:Pain', memo: 'croissants', numero: '', splits: [] });
  assert.equal(ops[1].statut, 'pointe');
  assert.deepEqual(ops[1].splits, [
    { categorie: 'Alimentation', memo: '', montant: -7000 },
    { categorie: 'Maison', memo: 'ampoules', montant: -3000 },
  ]);
});

test('récurrences : date suivante bornée au dernier jour du mois', () => {
  assert.equal(app.avancerDate('2026-01-31', 'mensuelle', 31, 1), '2026-02-28');
  assert.equal(app.avancerDate('2026-02-28', 'mensuelle', 31, 1), '2026-03-31');
  assert.equal(app.avancerDate('2024-01-31', 'mensuelle', 31, 1), '2024-02-29');
  assert.equal(app.avancerDate('2026-11-15', 'mensuelle', 15, 2), '2027-01-15');
});

test('récurrences : échéances passées créées, la prochaine en prévisionnel, une seule fois', () => {
  app.todayISO = () => '2026-03-20';
  app.run("INSERT INTO compte(nom,type,solde_initial) VALUES('Courant','courant',100000)");
  const compte = app.lastId();
  app.run(`INSERT INTO recurrence(compte_id,type,montant,tiers,cat_path,frequence,intervalle,jour,date_debut,prochaine,creer_en)
           VALUES(?,'debit',-80000,'Loyer','Logement',  'mensuelle',1,5,'2026-01-05','2026-01-05','previsionnel')`, [compte]);
  assert.equal(app.genererRecurrences(), 4);
  const ops = js(app.qy('SELECT date_operation d, montant, previsionnel p FROM operation WHERE compte_id=? ORDER BY d', [compte]));
  assert.deepEqual(ops, [
    { d: '2026-01-05', montant: -80000, p: 0 },
    { d: '2026-02-05', montant: -80000, p: 0 },
    { d: '2026-03-05', montant: -80000, p: 0 },
    { d: '2026-04-05', montant: -80000, p: 1 },
  ]);
  assert.equal(app.genererRecurrences(), 0, 'relancer ne crée pas de doublon');
  // solde réel : initial + échéances passées (pas le prévisionnel)
  assert.equal(app.soldeReel(compte), 100000 - 3 * 80000);

  // le jour de l'échéance, l'aperçu prévisionnel devient réel et le suivant apparaît
  app.todayISO = () => '2026-04-05';
  assert.equal(app.genererRecurrences(), 1);
  assert.deepEqual(js(app.qy("SELECT date_operation d, previsionnel p FROM operation WHERE compte_id=? AND date_operation>='2026-04-01' ORDER BY d", [compte])),
    [{ d: '2026-04-05', p: 0 }, { d: '2026-05-05', p: 1 }]);
});

test('relevé PDF : montants et dates au format de la banque', () => {
  assert.equal(app.relMontant('1.234,56'), 123456);
  assert.equal(app.relMontant('12,00'), 1200);
  assert.equal(app.relDateISO('05/01/2026'), '2026-01-05');
  assert.equal(app.relDateISO('5/1/2026'), null);
});

// Texte d'une page de relevé tel que pdf.js le donne : un morceau par position (x, y).
const morceau = (s, x, y) => ({ str: s, transform: [1, 0, 0, 1, x, y] });
const pageReleve = [
  morceau('C/C EUROCOMPTE N° 00012345601 en euros', 40, 700),
  morceau('Date', 40, 680), morceau('Opération', 120, 680), morceau('Débit', 430, 680), morceau('Crédit', 520, 680),
  morceau('SOLDE CREDITEUR AU 31/12/2025', 120, 660), morceau('1.500,00', 530, 660),
  morceau('05/01/2026', 40, 640), morceau('05/01/2026', 200, 640), morceau('PAIEMENT CB BOULANGERIE', 260, 640), morceau('4,50', 440, 640),
  morceau('LYON', 120, 628),
  morceau('10/01/2026', 40, 600), morceau('VIR SALAIRE', 120, 600), morceau('2.100,00', 530, 600),
  morceau('Caisse de Crédit Mutuel - société coopérative', 40, 60),
];

test('relevé PDF : opérations, sens débit/crédit, libellé sur deux lignes, soldes', () => {
  const comptes = js(app.parseReleve([pageReleve, pageReleve]));
  assert.equal(comptes.length, 1, 'le même compte sur deux pages est réuni');
  const [c] = comptes;
  assert.equal(c.cle, 'n:00012345601');
  assert.deepEqual(c.ops.map(o => [o.date, o.montant, o.libelle]), [
    ['2026-01-05', -450, 'PAIEMENT CB BOULANGERIE LYON'],
    ['2026-01-10', 210000, 'VIR SALAIRE'],
  ]);
  assert.deepEqual(c.soldes, [{ date: '2025-12-31', montant: 150000 }]);
});

test('rapprochement : montant identique prioritaire, montant proche proposé, le reste à créer', () => {
  const rel = [
    { date: '2026-01-05', montant: -450, libelle: 'BOULANGERIE' },
    { date: '2026-01-10', montant: -5230, libelle: 'SUPERMARCHE' },
    { date: '2026-01-12', montant: -999, libelle: 'INCONNU' },
  ];
  const appOps = [
    { id: 1, date: '2026-01-04', montant: -450, statut: 'non_pointe' },
    { id: 2, date: '2026-01-09', montant: -5200, statut: 'non_pointe' },
    { id: 3, date: '2026-02-20', montant: -999, statut: 'non_pointe' }, // trop loin dans le temps
  ];
  const r = js(app.comparer(rel, appOps));
  assert.deepEqual(r.rapproches.map(x => [x.rel.libelle, x.app.id]), [['BOULANGERIE', 1]]);
  assert.deepEqual(r.proches.map(x => [x.rel.libelle, x.app.id, x.ecartMontant]), [['SUPERMARCHE', 2, 30]]);
  assert.deepEqual(r.aCreer.map(x => (x.rel || x).libelle), ['INCONNU']);
});

test('relevé Amex (CSV)', () => {
  assert.deepEqual(js(app.csvSplit('a,"b, c","d ""e"""')), ['a', 'b, c', 'd "e"']);
  assert.equal(app.usDateToISO('1/31/2026'), '2026-01-31');
  const lignes = js(app.parseAmexCSV([
    'Date,Description,Titulaire,Compte,Montant',
    '01/15/2026,"RESTAURANT  PARIS",X,-1001,"42,30"',
    'ligne invalide',
  ].join('\n')));
  assert.deepEqual(lignes, [{ date: '2026-01-15', desc: 'RESTAURANT PARIS', montant: 4230 }]);
});

test('migration : une ancienne base reçoit les colonnes ajoutées depuis', () => {
  for (const [table, col] of [['operation', 'recurrence_id'], ['compte', 'numero'], ['recurrence', 'ventil'], ['operation', 'miroir_id'], ['recurrence', 'compte_cible']])
    assert.ok(app.colonneExiste(table, col), `${table}.${col}`);
  app.migrer(); // relancer ne casse rien
});

test('appli Android : comparaison des versions', () => {
  assert.equal(app.versionPlusRecente('2.1.0', '2.0.9'), true);
  assert.equal(app.versionPlusRecente('2.10.0', '2.9.0'), true); // nombres, pas texte
  assert.equal(app.versionPlusRecente('3.0.0', '2.99.99'), true);
  assert.equal(app.versionPlusRecente('2.1.0', '2.1.0'), false);
  assert.equal(app.versionPlusRecente('2.0.9', '2.1.0'), false);
});

test('appli Android : mise à jour proposée seulement si version.json est valide et plus récent', () => {
  const apk = 'https://marynedey.github.io/Comptabilite/android/mes-comptes-2.2.0.apk';
  assert.deepEqual(js(app.majAppliDisponible({ version: '2.2.0', apk }, '2.1.0')), { version: '2.2.0', apk });
  assert.equal(app.majAppliDisponible({ version: '2.1.0', apk }, '2.1.0'), null);     // déjà à jour
  assert.equal(app.majAppliDisponible({ version: '2.0.0', apk }, '2.1.0'), null);     // plus ancienne
  assert.equal(app.majAppliDisponible({ version: '2.2.0', apk: 'https://exemple.fr/x.apk' }, '2.1.0'), null); // autre site
  assert.equal(app.majAppliDisponible({ version: 'demain', apk }, '2.1.0'), null);
  assert.equal(app.majAppliDisponible(null, '2.1.0'), null);
});

test('appli Android : base64 de la sauvegarde, même pour une grosse base', () => {
  const octets = new Uint8Array(200000).map((_, i) => (i * 7) % 256);
  assert.deepEqual(new Uint8Array(Buffer.from(app.enBase64(octets), 'base64')), octets);
  assert.equal(app.enBase64(new Uint8Array([83, 81, 76])), 'U1FM');
});

test('sauvegarde : nom du fichier et message (dossier où il a été mis)', () => {
  assert.equal(app.nomSauvegarde(new Date(2026, 9, 5, 8, 3, 9)), 'comptes_2026-10-05_08h03m09.sqlite');
  assert.equal(app.messageSauvegarde('Comptes', 'comptes_2026-10-05_08h03m09.sqlite'),
    'Sauvegarde enregistrée dans « Comptes » : comptes_2026-10-05_08h03m09.sqlite');
});

test('prévisionnel : 3 jours, fin du mois, fin du mois prochain, masqué ; « tout » n\'existe plus', () => {
  const d = new Date(2026, 9, 26); // 26 octobre 2026
  assert.equal(app.borneHorizon('3', d), '2026-10-29');
  assert.equal(app.borneHorizon('finmois', d), '2026-10-31');
  assert.equal(app.borneHorizon('finmoisprochain', d), '2026-11-30');
  assert.equal(app.borneHorizon('finmoisprochain', new Date(2026, 11, 15)), '2027-01-31'); // décembre → fin janvier
  assert.equal(app.borneHorizon('masque', d), 'MASQUE');
  assert.equal(app.borneHorizon('tout', d), '2026-10-31'); // ancien réglage enregistré
});

test('moyenne par mois : mois du calendrier (janvier → octobre = 10 mois, pas 9,8)', () => {
  assert.equal(app.nbMoisCalendaires(new Date(2026, 0, 1), new Date(2026, 9, 26)), 10);
  assert.equal(app.nbMoisCalendaires(new Date(2026, 6, 1), new Date(2026, 8, 30)), 3);
  assert.equal(app.nbMoisCalendaires(new Date(2025, 10, 15), new Date(2026, 1, 2)), 4);
});

test('catégories : une sous-catégorie n\'est gardée que si elle appartient à la catégorie', () => {
  app.upsertCategorie('Alimentation : Courses');
  app.upsertCategorie('Loisirs : Cinéma');
  assert.equal(app.sousCatValide('Alimentation', 'Courses'), true);
  assert.equal(app.sousCatValide('Alimentation', 'courses'), true);
  assert.equal(app.sousCatValide('Loisirs', 'Courses'), false);
  assert.equal(app.sousCatValide('Loisirs', ''), true);
});

test('téléphone : titres des jours de la liste', () => {
  const auj = new Date(2026, 9, 26, 10);
  assert.equal(app.libJour('2026-10-26', auj), 'Aujourd’hui');
  assert.equal(app.libJour('2026-10-25', auj), 'Hier');
  assert.equal(app.libJour('2026-10-27', auj), 'Demain');
  assert.equal(app.libJour('2026-10-23', auj), 'Vendredi 23 octobre');
  assert.equal(app.libJour('2025-12-31', auj), 'Mercredi 31 décembre 2025');
});

test('téléphone : mois du filtre, ‹ et ›', () => {
  const auj = new Date(2026, 9, 26);
  assert.equal(app.moisDecale('tout', -1, auj), 'moisdernier');   // depuis « Tout » : le mois avant celui en cours
  assert.equal(app.moisDecale('tout', 0, auj), 'mois');
  assert.equal(app.moisDecale('moisdernier', -1, auj), 'm:2026-08');
  assert.equal(app.moisDecale('m:2026-08', 1, auj), 'moisdernier');
  assert.equal(app.moisDecale('m:2026-01', -1, auj), 'm:2025-12');
  assert.equal(app.moisDecale('mois', 1, auj), 'm:2026-11');
  assert.equal(app.libellePeriode('m:2025-12', auj), 'Décembre 2025');
  assert.equal(app.libellePeriode('mois', auj), 'Octobre 2026');
  assert.equal(app.libellePeriode('annee', auj), 'Cette année');
});

test('réglages d\'affichage : valeurs par défaut et valeurs inconnues ignorées', () => {
  assert.deepEqual(js(app.lireReglages(null)), { theme: 'auto', recherche: 'haut', masquer: false });
  assert.deepEqual(js(app.lireReglages('{"theme":"sombre","recherche":"bas","masquer":true}')), { theme: 'sombre', recherche: 'bas', masquer: true });
  assert.deepEqual(js(app.lireReglages('{"theme":"violet","recherche":"gauche","masquer":"oui"}')), { theme: 'auto', recherche: 'haut', masquer: false });
  assert.deepEqual(js(app.lireReglages('pas du json')), { theme: 'auto', recherche: 'haut', masquer: false });
});

test('analyse (téléphone) : périodes, comparaison, regroupement par catégorie', () => {
  assert.deepEqual(js(app.bornesPeriodeAna('2026-02')), { f: '2026-02-01', t: '2026-02-28' });
  assert.deepEqual(js(app.bornesPeriodeAna('2026')), { f: '2026-01-01', t: '2026-12-31' });
  assert.equal(app.periodeDecalee('2026-01', -1), '2025-12');
  assert.equal(app.periodeDecalee('2025', 1), '2026');
  assert.equal(app.libellePeriodeAna('2026-09'), 'Septembre 2026');
  assert.equal(app.ecartPct(125, 100), '+25 %');
  assert.equal(app.ecartPct(80, 100), '−20 %');
  assert.equal(app.ecartPct(100, 100), '=');
  assert.equal(app.ecartPct(50, 0), null);
  // une dépense répartie, une simple, un revenu, un virement
  const L = [
    { m: -6000, cat: 'Alimentation : Courses', vir: false, ti: 'Super' },
    { m: -1000, cat: 'Alimentation', vir: false, ti: 'Super' },
    { m: -3000, cat: 'Logement', vir: false, ti: 'Loyer' },
    { m: 200000, cat: 'Revenus', vir: false, ti: 'Salaire' },
    { m: -20000, cat: 'Virement', vir: true, ti: 'Livret A' },
  ];
  assert.deepEqual(js(app.regrouperAnalyse(L, 'debit', false, [])).map(g => [g.nom, g.total]), [['Alimentation', 7000], ['Logement', 3000]]);
  assert.deepEqual(js(app.regrouperAnalyse(L, 'debit', false, ['Alimentation'])).map(g => [g.nom, g.total]), [['Courses', 6000], ['Sans sous-catégorie', 1000]]);
  assert.deepEqual(js(app.regrouperAnalyse(L, 'debit', true, [])).map(g => g.nom), ['Virements', 'Alimentation', 'Logement']);
  assert.equal(app.totalAnalyse(L, 'credit', false, []), 200000);
});

test('évolution : solde réel à chaque fin de mois (sans prévisionnel ni annulées), du mois qui précède au jour même', () => {
  app.run("INSERT INTO compte(nom,type,solde_initial) VALUES('Évolution','courant',50000)");
  const c = app.scal("SELECT id FROM compte WHERE nom='Évolution'");
  const ins = (d, m, st, pv) => app.run("INSERT INTO operation(compte_id,date_operation,montant,statut,supprime,previsionnel) VALUES(?,?,?,?,0,?)", [c, d, m, st, pv]);
  ins('2026-06-15', -10000, 'pointe', 0); ins('2026-08-02', 30000, 'rapproche', 0);
  ins('2026-08-20', -99999, 'annule', 0); ins('2026-10-10', -5000, 'non_pointe', 0);
  ins('2026-10-20', -7000, 'pointe', 1);   // prévisionnelle
  ins('2026-10-28', 2000, 'pointe', 0);    // après aujourd'hui
  const auj = new Date(2026, 9, 26);
  assert.equal(app.debutEvolution([c], '6', auj), '2026-05');
  assert.equal(app.debutEvolution([c], 'annee', auj), '2026-01');
  assert.equal(app.debutEvolution([c], 'tout', auj), '2026-06');
  assert.deepEqual(JSON.parse(JSON.stringify(app.serieEvolution([c], '2026-06', auj))), [
    { cle: '2026-05', v: 50000 }, { cle: '2026-06', v: 40000 }, { cle: '2026-07', v: 40000 },
    { cle: '2026-08', v: 70000 }, { cle: '2026-09', v: 70000 }, { cle: '2026-10', v: 65000 }]);
  const flux = app.fluxEvolution([c], '2026-06', auj);
  assert.deepEqual({ ...flux.get('2026-08') }, { rev: 30000, dep: 0 });
  assert.deepEqual({ ...flux.get('2026-10') }, { rev: 0, dep: 5000 });
});

test('échéances (téléphone) : ce mois-ci / ensuite / suspendues ; reste à payer ce mois, hebdomadaires comptées à chaque passage', () => {
  const r = (o) => Object.assign({ actif: 1, frequence: 'mensuelle', intervalle: 1, jour: null, date_fin: null, compte_cible: null }, o);
  const recs = [
    r({ id: 1, tiers: 'Loyer', montant: -60000, prochaine: '2026-10-30', jour: 30 }),
    r({ id: 2, tiers: 'Salaire', montant: 200000, prochaine: '2026-11-05', jour: 5 }),
    r({ id: 3, tiers: 'Marché', montant: -2000, prochaine: '2026-10-27', frequence: 'hebdomadaire' }),
    r({ id: 4, tiers: 'Épargne', montant: -10000, prochaine: '2026-10-28', compte_cible: 9 }),
    r({ id: 5, tiers: 'Gym', montant: -3000, prochaine: '2026-10-29', actif: 0 }),
  ];
  const E = app.echeancesMobile(recs, '2026-10-26');
  assert.deepEqual([...E.mois.map(x => x.id)], [3, 4, 1]);
  assert.deepEqual([...E.ensuite.map(x => x.id)], [2]);
  assert.deepEqual([...E.suspendues.map(x => x.id)], [5]);
  assert.equal(E.aPayer, -60000 - 2000);   // le virement ne compte pas, la suspendue non plus
  assert.equal(E.aRecevoir, 0);
});
