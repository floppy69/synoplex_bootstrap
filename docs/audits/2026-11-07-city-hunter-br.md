# Syno Plex : audit City Hunter / Nicky Larson (7 novembre 2026)

## Objectif

Vérifier l'origine effective de la série dans la bibliothèque Plex/Sonarr, sans déplacer, supprimer, renommer ou réimporter de médias.

## Résultats observés

- Sonarr, série **City Hunter** (TVDB 72877, 1987, id interne 45) : **140 épisodes réguliers enregistrés et présents sur disque**.
- Répartition : S01 = 51/51, S02 = 63/63, S03 = 13/13, S04 = 13/13. Neuf spéciaux S00 ne sont pas enregistrés, conformément à leur surveillance distincte.
- Les **140 fichiers bibliothèque** sont des fichiers réguliers accessibles. Aucun lien symbolique et aucun fichier manquant.
- Torrent C411 **City Hunter - Nicky Larson [Multi] [BR]** (hash commençant par `e447950fdb77`) : **140 vidéos achevées**. Chacune des 140 tailles déclarées par qBittorrent est **strictement identique** à la taille réelle de l'épisode Sonarr correspondant.
- Torrent DragonMax, intégrale DVDRip 140 fichiers (hash préfixe `af0126df2041`) : **0/140 tailles correspondantes**.
- Torrents T3KASHi remaster S01 (51 épisodes, préfixe `c1382511ca30`) et S02 (63, préfixe `4fd224365d8c`) : **0/51** et **0/63** tailles correspondantes.
- Aucune correspondance ambiguë ou dupliquée dans le manifeste BR, aucune source incomplète.

## Interprétation et limites

La concordance parfaite sur 140 tailles, et l'absence de concordance des releases concurrentes, sont des **indices matériels très forts** que la bibliothèque contient déjà la release BR prioritaire.

**Ce n'est pas une preuve de contenu bit pour bit**. Le torrent BR réside dans `/volume1/downloads/complete`, qui n'est pas visible à travers le mapping `media_root` / `n8n_media_root` utilisé par l'orchestrateur. Une confirmation cryptographique exigerait une lecture des fichiers source depuis un montage adapté sur l'hôte n8n ou un audit direct sur le NAS.

Les fichiers bibliothèque ne sont pas des symlinks. Les hardlinks et copies indépendantes ne peuvent être départagés sans comparer les métadonnées/inodes de la source BR avec celles des 140 fichiers bibliothèque.

## Décision de sûreté

**Pas de réimport, pas de déplacement, pas de suppression.** La série est déjà complète et la release BR correspond aux tailles. Aucun gain démontré ne justifie une opération risquant de casser la bibliothèque ou le seed.

Le contrôle taille est maintenant intégré au nœud existant `NAS - Audit doublons intégrales et saisons (lecture seule)`, dans le workflow `PLEX Bootstrap Synology - Orchestrator`. Il produit :

`STRONG_140_OF_140_SIZE_MATCH_NOT_HASH_VERIFIED`

Il reste en lecture seule et ne déclare jamais de preuve cryptographique.

## Traçabilité

- Audit d'inventaire n8n : exécution `33683`
- Audit des fichiers réels Sonarr : exécution `33684`
- Comparaison des tailles : exécution `33685`
- Test du nœud d'audit amélioré : exécution `33687`
- Version n8n publiée intégrant le contrôle : `b2bb9c60-78fa-4505-a25b-bd9bd60f55a6`
- Les opérations destructrices, changements qBittorrent, imports Radarr/Sonarr et déplacement de médias étaient **absents** de ces diagnostics.

## Étape restante

Si une preuve cryptographique est requise avant une opération future, monter en lecture seule le dossier de source BR dans n8n ou exécuter sur le NAS un rapprochement SHA-256 fichier par fichier, puis lier cette preuve aux 140 enregistrements Sonarr.
