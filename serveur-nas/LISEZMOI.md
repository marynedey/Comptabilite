# Sauvegarde directe sur le NAS

Petit service qui reçoit les sauvegardes de l'app et les écrit dans un dossier du NAS.
Avec lui, **Sauvegarder** envoie le fichier `comptes_….sqlite` directement dans ce dossier,
depuis le PC comme depuis le téléphone. Si le NAS ne répond pas, l'app télécharge le fichier
sur l'appareil comme avant, puis l'envoie au NAS dès qu'il répond de nouveau.

- `sauvegarde.py` : le service (Python 3, bibliothèque standard seulement).
- `docker-compose.yml` + `docker.env.exemple` : installation dans Docker (recommandée).
- `mes-comptes-nas.service` + `sauvegarde.env.exemple` : installation dans un conteneur LXC dédié (systemd).

Le service sait faire une seule chose : écrire des fichiers `comptes_….sqlite` dans **ce** dossier,
quand on lui donne le bon jeton. Il ne sait ni lire, ni lister, ni effacer tes fichiers ; seule exception,
s'il est réglé pour garder les N dernières sauvegardes, il supprime les plus anciennes.

## 1. Installer le service

Le service ne tourne **pas** dans la VM OpenMediaVault : il a sa place à part (Docker ou son propre LXC)
et écrit dans un sous-dossier du partage OMV monté là où il tourne. Il a seulement besoin d'un dossier
où écrire ; le reste du NAS lui reste inaccessible.

**Dossier des sauvegardes :** créer sur OMV un sous-dossier, par exemple `Comptes/sauvegardes` dans un
dossier partagé, accessible en écriture à l'utilisateur sous lequel tournera le service.

### Méthode 1 : dans Docker (LXC 300)

1. Rendre le dossier visible dans le LXC 300 (au choix de l'admin) :
   - **point de montage Proxmox** depuis le stockage `nas-omv` déjà monté sur l'hôte, par exemple
     `pct set 300 -mp0 /mnt/pve/nas-omv/Comptes/sauvegardes,mp=/mnt/comptes/sauvegardes`
     (LXC non privilégié : l'UID du conteneur est décalé de 100000 côté hôte, à prendre en compte
     dans les droits du dossier) ;
   - ou **montage NFS/SMB** du partage directement dans le LXC, si celui-ci y est autorisé.
2. Dans le LXC 300 :
   ```bash
   mkdir -p /opt/mes-comptes-nas && cd /opt/mes-comptes-nas
   for f in sauvegarde.py docker-compose.yml docker.env.exemple; do
     wget -q https://raw.githubusercontent.com/marynedey/Comptabilite/main/serveur-nas/$f
   done
   cp docker.env.exemple .env && chmod 600 .env
   python3 -c "import secrets; print(secrets.token_urlsafe(32))"   # le jeton, à mettre dans .env et dans l'app
   nano .env      # JETON, DOSSIER_HOTE (ex. /mnt/comptes/sauvegardes), UID_GID qui peut y écrire
   docker compose up -d
   docker compose logs     # « Sauvegardes « Mes comptes » : http://0.0.0.0:8080 → /sauvegardes »
   curl -H "Authorization: Bearer LE_JETON" http://localhost:8080/ping     # → {"ok": true}
   ```
   Le conteneur tourne sans droits (`cap_drop: ALL`, système de fichiers en lecture seule, utilisateur
   non root) ; seul le dossier des sauvegardes est monté en écriture.

### Méthode 2 : dans un conteneur LXC dédié (sans Docker)

Un petit LXC Debian (128 Mo de RAM suffisent) avec le dossier monté comme ci-dessus, puis :

```bash
apt install -y python3 wget
mkdir -p /opt/mes-comptes-nas /etc/mes-comptes-nas
wget -O /opt/mes-comptes-nas/sauvegarde.py https://raw.githubusercontent.com/marynedey/Comptabilite/main/serveur-nas/sauvegarde.py
wget -O /etc/systemd/system/mes-comptes-nas.service https://raw.githubusercontent.com/marynedey/Comptabilite/main/serveur-nas/mes-comptes-nas.service
wget -O /etc/mes-comptes-nas/sauvegarde.env https://raw.githubusercontent.com/marynedey/Comptabilite/main/serveur-nas/sauvegarde.env.exemple
groupadd -f users
useradd --system --user-group --groups users --no-create-home --shell /usr/sbin/nologin mes-comptes
nano /etc/mes-comptes-nas/sauvegarde.env && chmod 600 /etc/mes-comptes-nas/sauvegarde.env   # DOSSIER, JETON
systemctl daemon-reload && systemctl enable --now mes-comptes-nas
curl -H "Authorization: Bearer LE_JETON" http://localhost:8080/ping     # → {"ok": true}
```

## 2. Le rendre joignable en HTTPS

**Pourquoi un certificat, même derrière WireGuard ?** Le tunnel chiffre bien le trafic, mais la
contrainte vient du navigateur : l'app est servie en HTTPS (`https://marynedey.github.io`), et Chrome
bloque toute requête d'une page HTTPS vers une adresse en `http://` (*mixed content*), quel que soit
le réseau emprunté ; il ne sait pas qu'il y a un VPN. Le service doit donc répondre en `https://`
avec un certificat que le navigateur reconnaît, sans quoi la requête n'est même pas envoyée.
(Seules `http://localhost` et `http://127.0.0.1` échappent à cette règle.)

Deux possibilités, gratuites toutes les deux puisque le domaine `thomas-jacques.com` est chez Cloudflare :

### Option A : par le tunnel Cloudflare (recommandé : marche partout, même sans VPN)

Ton conteneur `100 (cloudflared)` publie déjà Proxmox ; on y ajoute une adresse pour le service.

1. https://one.dash.cloudflare.com → *Networks → Tunnels* → ton tunnel → *Configure* →
   onglet *Public Hostname* (ou *Published application routes*) → **Add**.
2. *Subdomain* : `comptes` · *Domain* : `thomas-jacques.com` · *Service* : `HTTP` ·
   *URL* : `IP_DU_SERVICE:8080` (l'IP locale du LXC où tourne le service, par exemple `192.168.1.30:8080`).
3. Enregistrer. L'adresse à mettre dans l'app est `https://comptes.thomas-jacques.com`.

À savoir :
- Le service est alors **joignable depuis internet**. Il est protégé par le jeton (long et aléatoire)
  et ne fait qu'écrire des fichiers `.sqlite` : c'est raisonnable, mais garde le jeton secret.
- Si tu protèges tes sous-domaines avec **Cloudflare Access** (page de connexion Cloudflare),
  ne l'applique pas à `comptes.thomas-jacques.com` : l'app ne pourrait plus envoyer.
- Le fichier passe par Cloudflare (chiffré entre ton téléphone et Cloudflare, puis dans le tunnel).

### Option B : seulement par le VPN (rien d'exposé sur internet)

Rien d'exposé sur internet : ça ne marche qu'à la maison ou avec WireGuard actif, l'app gardant la
sauvegarde en attente le reste du temps. Le certificat s'obtient par le DNS Cloudflare (challenge DNS-01),
sans rien ouvrir sur internet.

1. Cloudflare → *DNS* : un enregistrement `A` `comptes-lan` → IP locale du service (ou du reverse proxy),
   **nuage gris** (*DNS only*).
2. Cloudflare → *My Profile → API Tokens* : un jeton *Edit zone DNS* limité à `thomas-jacques.com`.
3. Le HTTPS, au choix :
   - **reverse proxy interne** (Caddy, Traefik, Nginx Proxy Manager…) avec le plugin DNS Cloudflare,
     qui renvoie vers `http://IP_DU_SERVICE:8080` : le plus simple avec Docker ;
   - ou **le service lui-même** (méthode 2) :
     ```bash
     apt install certbot python3-certbot-dns-cloudflare
     echo "dns_cloudflare_api_token = LE_JETON_CLOUDFLARE" > /root/cloudflare.ini && chmod 600 /root/cloudflare.ini
     certbot certonly --dns-cloudflare --dns-cloudflare-credentials /root/cloudflare.ini -d comptes-lan.thomas-jacques.com \
       --deploy-hook 'install -m 640 -g mes-comptes $RENEWED_LINEAGE/fullchain.pem $RENEWED_LINEAGE/privkey.pem /etc/mes-comptes-nas/ && systemctl restart mes-comptes-nas'
     ```
     puis dans `/etc/mes-comptes-nas/sauvegarde.env` : `PORT=8443`,
     `CERT=/etc/mes-comptes-nas/fullchain.pem`, `CLE=/etc/mes-comptes-nas/privkey.pem`, et
     `systemctl restart mes-comptes-nas`.
4. L'adresse à mettre dans l'app est `https://comptes-lan.thomas-jacques.com` (avec le port s'il n'est pas 443).
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
| NAS injoignable | service arrêté (`docker compose ps` ou `systemctl status mes-comptes-nas`), mauvaise adresse, pas de VPN (option B), tunnel mal réglé (option A) |
| Jeton refusé par le NAS | le jeton de l'app n'est pas celui de `sauvegarde.env` |
| Le NAS a refusé (500 : écriture impossible…) | le dossier n'est pas accessible en écriture au groupe `users` (voir `chgrp`/`chmod` ci-dessus) |

Journal du service : `docker compose logs` (méthode 1) ou `journalctl -u mes-comptes-nas -n 50` (méthode 2).

## Mettre à jour le service

```bash
# méthode 1 (Docker)
cd /opt/mes-comptes-nas && wget -qO sauvegarde.py https://raw.githubusercontent.com/marynedey/Comptabilite/main/serveur-nas/sauvegarde.py && docker compose restart
# méthode 2 (LXC dédié)
wget -qO /opt/mes-comptes-nas/sauvegarde.py https://raw.githubusercontent.com/marynedey/Comptabilite/main/serveur-nas/sauvegarde.py && systemctl restart mes-comptes-nas
```
