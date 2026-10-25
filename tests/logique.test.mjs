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
