# Tontine Digital 1.0 — Backend

API Node.js (Express) + PostgreSQL pour l'application membre et l'espace administrateur.

## Ce qui est inclus
- Inscription avec code OTP par SMS (Africa's Talking), connexion, mot de passe oublié, verrouillage après 5 échecs
- Statuts de compte : en attente, actif, refusé, suspendu (validation par l'administrateur)
- Tontines : création (admin), adhésion, tirage au sort de l'ordre des bénéficiaires, passage au tour suivant
- Cotisations : devis, paiement (Wave implémenté ; mode `mock` pour tester), historique, calendrier
- Commissions : plateforme 1 % et parrainage 2 % (taux et règle « première cotisation / chaque cotisation » modifiables par l'admin)
- Discussion par tontine, notifications, parrainage
- Sécurité : mots de passe hachés (bcrypt), JWT, helmet, limitation de débit, requêtes paramétrées, journal d'audit admin

## Déploiement sur Render
1. Mettez ce dossier dans un dépôt GitHub.
2. Render → New → Blueprint (lit `render.yaml`) ou créez à la main un *PostgreSQL* et un *Web Service* (Build : `npm install`, Start : `npm start`).
3. Variables d'environnement (voir `.env.example`) : `DATABASE_URL`, `JWT_SECRET`, `PUBLIC_URL`, `ADMIN_PHONE`, `ADMIN_PASSWORD`, `CORS_ORIGINS` (adresse de votre front GitHub Pages), puis `AT_USERNAME` / `AT_API_KEY` pour les SMS.
4. Au démarrage, `npm start` crée les tables et le compte administrateur.
5. Vérifiez `https://VOTRE-API.onrender.com/health`.

Attention : une base PostgreSQL gratuite Render est supprimée après une période limitée. Pour de vrais utilisateurs, prenez un plan payant avec sauvegardes.

## Tester (mode test)
Mettez `DEV_SHOW_OTP=true` et `PAYMENT_MODE=mock` (jamais en production).

```bash
API=https://VOTRE-API.onrender.com/api
# 1. Inscription : renvoie dev_otp
curl -X POST $API/auth/register -H 'Content-Type: application/json' -d '{"name":"Awa Koné","birth_date":"1995-05-10","phone":"0701020304","doc_type":"CNI","doc_number":"C0012345","password":"motdepasse1","accept_terms":true}'
# 2. Validation du code -> renvoie un token
curl -X POST $API/auth/verify-otp -H 'Content-Type: application/json' -d '{"phone":"0701020304","code":"123456"}'
# 3. Connexion admin puis validation du membre
curl -X POST $API/auth/login -H 'Content-Type: application/json' -d '{"phone":"ADMIN_PHONE","password":"ADMIN_PASSWORD"}'
curl -X POST $API/admin/users/2/status -H "Authorization: Bearer TOKEN_ADMIN" -H 'Content-Type: application/json' -d '{"status":"active"}'
```

## Routes principales
Public : `POST /api/auth/register`, `/verify-otp`, `/login`, `/forgot`, `/reset`
Membre (jeton `Authorization: Bearer …`) : `GET /api/me`, `POST /api/me/password`, `GET /api/tontines`, `POST /api/tontines/:id/join`, `GET /api/payments/quote?tontine_id=`, `POST /api/payments`, `GET /api/payments`, `GET /api/calendar`, `GET|POST /api/tontines/:id/messages`, `GET /api/notifications`, `POST /api/notifications/read`, `GET /api/referral`
Admin : `GET /api/admin/stats`, `/users?status=pending`, `POST /users/:id/status`, `GET|POST /tontines`, `POST /tontines/:id/draw`, `POST /tontines/:id/next-round`, `GET /payments`, `GET|PUT /settings`
Webhook : `POST /webhooks/wave`

## Interfaces incluses
- `public/member/index.html` : application membre (accueil illustré, inscription + OTP, menu en tuiles, tontines, cotisation, historique, calendrier, discussion, notifications, parrainage, profil, photo de la pièce d'identité), servie sur `/member/`
- `public/admin/index.html` : espace administrateur (tableau de bord, validation des inscriptions avec visualisation de la pièce, membres, tontines avec tirage et tours, paiements, réglages des commissions), servi sur `/admin/`
- Pour héberger l'interface ailleurs (GitHub Pages), ajoutez avant le script : `<script>window.API_BASE='https://VOTRE-API.onrender.com'</script>` et renseignez `CORS_ORIGINS`.

## Paiements
- Wave, Orange Money et MTN MoMo sont écrits dans `src/payments.js`, mais **non testés** : les formats d'appel, les clés et les URL sont à valider avec la documentation et le compte marchand de chaque opérateur.
- Webhooks à déclarer chez les opérateurs : `POST /webhooks/wave`, `POST /webhooks/orange`. MTN est vérifié par interrogation de l'opérateur.
- `PAYMENT_MODE=mock` simule les paiements (tests) ; `PAYMENT_MODE=live` active les vrais.

## Reste à faire par vous (hors code)
1. Déployer sur Render et renseigner les variables d'environnement.
2. Ouvrir les comptes marchands Wave, Orange Money et MTN MoMo et y saisir les clés.
3. Passer Africa's Talking en production (`AT_SANDBOX=false`) avec un identifiant d'expéditeur approuvé.
4. Faire valider par un juriste les conditions d'utilisation, la protection des données personnelles et l'activité d'épargne collective.
5. Prendre une base PostgreSQL payante avec sauvegardes, puis tester un parcours complet avec de petits montants réels.

## Règle de commission à confirmer
Par défaut : 1 % sur la première cotisation seulement. Changez-la sans redéployer : `PUT /api/admin/settings` avec `{"commission_mode":"each"}`.
