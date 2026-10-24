# Sauvegarde directe sur le NAS

Petit service qui reçoit les sauvegardes de l'app et les écrit dans un dossier du NAS.
Avec lui, **Sauvegarder** envoie le fichier `comptes_….sqlite` directement dans ce dossier,
depuis le PC comme depuis le téléphone. Si le NAS ne répond pas, l'app télécharge le fichier
sur l'appareil comme avant, puis l'envoie au NAS dès qu'il répond de nouveau.

- `sauvegarde.py` : le service (Python 3, rien à installer en plus).
- `mes-comptes-nas.service` : démarrage automatique (systemd).
- `sauvegarde.env.exemple` : la configuration à recopier.

Le service sait faire une seule chose : écrire des fichiers `comptes_….sqlite` dans **ce** dossier,
quand on lui donne le bon jeton. Il ne sait ni lire, ni lister, ni effacer tes fichiers ; seule exception,
s'il est réglé pour garder les N dernières sauvegardes, il supprime les plus anciennes.

## 1. Installer le service sur la VM OpenMediaVault

Dans la console de la VM `200 (omv)` (Proxmox → 200 → *Console*, ou en `ssh`), en root :

```bash
# le service et sa configuration
mkdir -p /opt/mes-comptes-nas /etc/mes-comptes-nas
wget -O /opt/mes-comptes-nas/sauvegarde.py https://raw.githubusercontent.com/marynedey/Comptabilite/main/serveur-nas/sauvegarde.py
wget -O /etc/systemd/system/mes-comptes-nas.service https://raw.githubusercontent.com/marynedey/Comptabilite/main/serveur-nas/mes-comptes-nas.service
wget -O /etc/mes-comptes-nas/sauvegarde.env https://raw.githubusercontent.com/marynedey/Comptabilite/main/serveur-nas/sauvegarde.env.exemple

# un utilisateur dédié, sans droits, membre du groupe « users » (celui des dossiers partagés OMV)
useradd --system --user-group --groups users --no-create-home --shell /usr/sbin/nologin mes-comptes

# un jeton (mot de passe) : le noter, il faudra le recopier dans l'app
python3 -c "import secrets; print(secrets.token_urlsafe(32))"
```

**Trouver le chemin du dossier :** dans l'interface OMV, *Storage → Shared Folders*, colonne
**Absolute path** (afficher la colonne si besoin). Par exemple `/srv/dev-disk-by-uuid-1234…/Partage`.
Créer le sous-dossier des sauvegardes et le donner au groupe `users` :

```bash
mkdir -p "/srv/dev-disk-by-uuid-1234…/Partage/Comptes/sauvegardes"
chgrp users "/srv/dev-disk-by-uuid-1234…/Partage/Comptes/sauvegardes"
chmod 2775 "/srv/dev-disk-by-uuid-1234…/Partage/Comptes/sauvegardes"
```

Puis écrire la configuration (`DOSSIER`, `JETON`, le reste peut rester tel quel) :

```bash
nano /etc/mes-comptes-nas/sauvegarde.env
chmod 600 /etc/mes-comptes-nas/sauvegarde.env     # le jeton : lisible par root seulement

systemctl daemon-reload
systemctl enable --now mes-comptes-nas
systemctl status mes-comptes-nas     # doit afficher « active (running) »
```

Vérifier depuis la VM (remplacer le jeton) :

```bash
curl -H "Authorization: Bearer LE_JETON" http://localhost:8080/ping     # → {"ok": true}
```

## 2. Le rendre joignable en HTTPS

L'app est en HTTPS : le navigateur n'accepte d'envoyer qu'à une adresse **https://** avec un
certificat valide. Deux possibilités ; ton domaine `thomas-jacques.com` est chez Cloudflare,
les deux sont donc gratuites.

### Option A : par le tunnel Cloudflare (recommandé : marche partout, même sans VPN)

Ton conteneur `100 (cloudflared)` publie déjà Proxmox ; on y ajoute une adresse pour le service.

1. https://one.dash.cloudflare.com → *Networks → Tunnels* → ton tunnel → *Configure* →
   onglet *Public Hostname* (ou *Published application routes*) → **Add**.
2. *Subdomain* : `comptes` · *Domain* : `thomas-jacques.com` · *Service* : `HTTP` ·
   *URL* : `IP_DE_LA_VM_OMV:8080` (l'IP locale de la VM, par exemple `192.168.1.20:8080`).
3. Enregistrer. L'adresse à mettre dans l'app est `https://comptes.thomas-jacques.com`.

À savoir :
- Le service est alors **joignable depuis internet**. Il est protégé par le jeton (long et aléatoire)
  et ne fait qu'écrire des fichiers `.sqlite` : c'est raisonnable, mais garde le jeton secret.
- Si tu protèges tes sous-domaines avec **Cloudflare Access** (page de connexion Cloudflare),
  ne l'applique pas à `comptes.thomas-jacques.com` : l'app ne pourrait plus envoyer.
- Le fichier passe par Cloudflare (chiffré entre ton téléphone et Cloudflare, puis dans le tunnel).

### Option B : seulement par le VPN (rien d'exposé sur internet)

Le service fait lui-même le HTTPS, avec un certificat Let's Encrypt obtenu par le DNS Cloudflare
(rien à ouvrir sur internet). Ça ne marche qu'à la maison ou avec WireGuard actif, l'app gardant la
sauvegarde en attente le reste du temps.

1. Cloudflare → *DNS* : un enregistrement `A` `comptes-lan` → IP locale de la VM OMV,
   **nuage gris** (*DNS only*).
2. Cloudflare → *My Profile → API Tokens* : un jeton *Edit zone DNS* limité à `thomas-jacques.com`.
3. Sur la VM :
   ```bash
   apt install certbot python3-certbot-dns-cloudflare
   echo "dns_cloudflare_api_token = LE_JETON_CLOUDFLARE" > /root/cloudflare.ini && chmod 600 /root/cloudflare.ini
   certbot certonly --dns-cloudflare --dns-cloudflare-credentials /root/cloudflare.ini -d comptes-lan.thomas-jacques.com \
     --deploy-hook 'install -m 640 -g mes-comptes $RENEWED_LINEAGE/fullchain.pem $RENEWED_LINEAGE/privkey.pem /etc/mes-comptes-nas/ && systemctl restart mes-comptes-nas'
   ```
4. Dans `/etc/mes-comptes-nas/sauvegarde.env` : `PORT=8443`,
   `CERT=/etc/mes-comptes-nas/fullchain.pem`, `CLE=/etc/mes-comptes-nas/privkey.pem`,
   puis `systemctl restart mes-comptes-nas`.
5. L'adresse à mettre dans l'app est `https://comptes-lan.thomas-jacques.com:8443`.
   Avec WireGuard, il faut que le tunnel donne accès au réseau de la maison
   (*AllowedIPs* contient par exemple `192.168.1.0/24`).

## 3. Régler l'app

Sur chaque appareil (PC, téléphone) : **Sauvegarde NAS** (en haut, à côté de « Charger une sauvegarde »)
→ adresse + jeton → **Tester** (« NAS joignable, jeton accepté ✓ ») → **Enregistrer**.
Chrome peut demander une fois l'autorisation d'accéder aux appareils du réseau local : accepter.

L'adresse et le jeton restent dans le navigateur de l'appareil ; ils ne sont jamais dans la base
ni dans les fichiers de sauvegarde.

## Dépannage

| Message dans l'app | Cause probable |
|---|---|
| NAS injoignable | service arrêté (`systemctl status mes-comptes-nas`), mauvaise adresse, pas de VPN (option B), tunnel mal réglé (option A) |
| Jeton refusé par le NAS | le jeton de l'app n'est pas celui de `sauvegarde.env` |
| Le NAS a refusé (500 : écriture impossible…) | le dossier n'est pas accessible en écriture au groupe `users` (voir `chgrp`/`chmod` ci-dessus) |

Journal du service : `journalctl -u mes-comptes-nas -n 50`.

## Mettre à jour le service

```bash
wget -O /opt/mes-comptes-nas/sauvegarde.py https://raw.githubusercontent.com/marynedey/Comptabilite/main/serveur-nas/sauvegarde.py
systemctl restart mes-comptes-nas
```
