#!/usr/bin/env python3
"""Reçoit les sauvegardes de l'app « Mes comptes » et les écrit dans un dossier du NAS.

Python 3 seul, sans dépendance. Réglages par variables d'environnement
(voir LISEZMOI.md et sauvegarde.env.exemple) :
  DOSSIER      dossier où écrire les sauvegardes (obligatoire)
  JETON        mot de passe à saisir dans l'app (obligatoire, 16 caractères ou plus)
  PORT         port d'écoute (défaut 8443)
  CERT, CLE    certificat et clé HTTPS ; sans eux le service parle en HTTP
               (seulement derrière un reverse proxy qui fait le HTTPS)
  ORIGINE      adresse de l'app autorisée (défaut https://marynedey.github.io)
  GARDER       nombre de sauvegardes gardées, les plus anciennes sont supprimées (défaut 0 = toutes)
  TAILLE_MAX   taille maximale d'une sauvegarde en Mo (défaut 200)

Ce que fait le service, et rien d'autre :
  GET  /ping                   vérifie le jeton, répond {"ok": true}
  PUT  /sauvegardes/<fichier>  écrit comptes_….sqlite dans DOSSIER (jamais ailleurs)
Il ne sait ni lire ni lister ni effacer les fichiers (sauf la rotation GARDER).
"""
import hmac
import json
import os
import re
import ssl
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

NOM_VALIDE = re.compile(r'^comptes_[0-9A-Za-z_-]{1,80}\.sqlite$')
ENTETE_SQLITE = b'SQLite format 3\x00'


def config():
    env = os.environ
    dossier, jeton = env.get('DOSSIER', ''), env.get('JETON', '')
    if not dossier or not Path(dossier).is_dir():
        sys.exit(f'DOSSIER introuvable : « {dossier} »')
    if len(jeton) < 16:
        sys.exit('JETON manquant ou trop court (16 caractères minimum)')
    return {
        'dossier': Path(dossier).resolve(),
        'jeton': jeton.encode(),
        'port': int(env.get('PORT', '8443')),
        'cert': env.get('CERT', ''),
        'cle': env.get('CLE', ''),
        'origine': env.get('ORIGINE', 'https://marynedey.github.io').rstrip('/'),
        'garder': int(env.get('GARDER', '0')),
        'taille_max': int(env.get('TAILLE_MAX', '200')) * 1024 * 1024,
    }


def faire_tourner(dossier, garder):
    """Ne garde que les `garder` sauvegardes les plus récentes."""
    if garder <= 0:
        return
    fichiers = sorted((f for f in dossier.iterdir() if NOM_VALIDE.match(f.name)), key=lambda f: f.stat().st_mtime, reverse=True)
    for f in fichiers[garder:]:
        f.unlink(missing_ok=True)


class Gestionnaire(BaseHTTPRequestHandler):
    server_version = 'mes-comptes-nas'
    sys_version = ''
    cfg = None

    def log_message(self, fmt, *args):
        sys.stderr.write('%s %s\n' % (self.address_string(), fmt % args))

    def entetes_cors(self):
        # Seule l'app peut appeler le service depuis un navigateur.
        if self.headers.get('Origin', '').rstrip('/') == self.cfg['origine']:
            self.send_header('Access-Control-Allow-Origin', self.cfg['origine'])
            self.send_header('Vary', 'Origin')

    def repondre(self, code, corps):
        donnees = json.dumps(corps, ensure_ascii=False).encode()
        self.send_response(code)
        self.entetes_cors()
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(donnees)))
        self.end_headers()
        self.wfile.write(donnees)

    def vider(self):
        """Lit et jette le corps d'une requête refusée : sinon le navigateur voit
        la connexion coupée au lieu de la réponse."""
        try:
            reste = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            reste = 0
        if reste > 2 * self.cfg['taille_max']:
            self.close_connection = True
            return
        while reste > 0:
            bloc = self.rfile.read(min(reste, 1 << 16))
            if not bloc:
                break
            reste -= len(bloc)

    def autorise(self):
        recu = self.headers.get('Authorization', '')
        attendu = b'Bearer ' + self.cfg['jeton']
        if hmac.compare_digest(recu.encode(), attendu):
            return True
        self.repondre(401, {'erreur': 'jeton incorrect'})
        return False

    def do_OPTIONS(self):
        # Pré-vérification du navigateur (CORS, accès au réseau local).
        self.send_response(204)
        self.entetes_cors()
        self.send_header('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.send_header('Access-Control-Max-Age', '600')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        if self.path != '/ping':
            return self.repondre(404, {'erreur': 'introuvable'})
        if self.autorise():
            self.repondre(200, {'ok': True})

    def do_PUT(self):
        nom = self.path[len('/sauvegardes/'):]
        try:
            taille = int(self.headers.get('Content-Length', ''))
        except ValueError:
            taille = -1
        refus = None
        if not self.path.startswith('/sauvegardes/'):
            refus = (404, 'introuvable')
        elif not hmac.compare_digest(self.headers.get('Authorization', '').encode(), b'Bearer ' + self.cfg['jeton']):
            refus = (401, 'jeton incorrect')
        elif not NOM_VALIDE.match(nom):
            refus = (400, 'nom de fichier refusé')
        elif taille < 0:
            refus = (411, 'taille manquante')
        elif taille > self.cfg['taille_max']:
            refus = (413, 'fichier trop gros')
        if refus:
            self.vider()
            return self.repondre(refus[0], {'erreur': refus[1]})
        donnees = self.rfile.read(taille)
        if len(donnees) != taille or not donnees.startswith(ENTETE_SQLITE):
            return self.repondre(400, {'erreur': 'ce n\'est pas une base SQLite'})
        dossier = self.cfg['dossier']
        # Écriture dans un fichier temporaire puis renommage : jamais de fichier à moitié écrit.
        fd, tmp = tempfile.mkstemp(dir=dossier, prefix='.envoi-')
        try:
            with os.fdopen(fd, 'wb') as f:
                f.write(donnees)
                f.flush()
                os.fsync(f.fileno())
            os.chmod(tmp, 0o664)
            os.replace(tmp, dossier / nom)
        except OSError as e:
            Path(tmp).unlink(missing_ok=True)
            return self.repondre(500, {'erreur': f'écriture impossible : {e.strerror}'})
        faire_tourner(dossier, self.cfg['garder'])
        self.repondre(201, {'ok': True, 'fichier': nom, 'taille': taille})


def main():
    cfg = config()
    Gestionnaire.cfg = cfg
    serveur = ThreadingHTTPServer(('0.0.0.0', cfg['port']), Gestionnaire)
    protocole = 'http'
    if cfg['cert']:
        contexte = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        contexte.load_cert_chain(cfg['cert'], cfg['cle'] or None)
        serveur.socket = contexte.wrap_socket(serveur.socket, server_side=True)
        protocole = 'https'
    print(f'Sauvegardes « Mes comptes » : {protocole}://0.0.0.0:{cfg["port"]} → {cfg["dossier"]}', flush=True)
    serveur.serve_forever()


if __name__ == '__main__':
    main()
