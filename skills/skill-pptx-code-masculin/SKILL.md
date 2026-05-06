---
name: skill-pptx-code-masculin
description: >
  Génère les spécifications et le contenu des slides PowerPoint du programme Code Masculin
  selon le design system exact de Pilier Conscient. Utilise cette skill quand Prince Johann
  veut créer ou compléter un module PowerPoint — structure des 14 slides, contenu par slide,
  tokens de design. Le code de génération utilise pptxgenjs ou Python-pptx.
---

# PPTX Code Masculin — Design System & Contenu

## DESIGN SYSTEM EXACT

```
Couleurs :
→ Navy principal : #1A1A2E
→ Gold accent : #C4A35A
→ Cream texte clair : #F2EDE3
→ Blanc pur : #FFFFFF
→ Gris foncé : #2D2D44

Typographie :
→ Titres : Calibri Bold, 36-44pt
→ Corps : Calibri Regular, 18-22pt
→ Accent : Calibri Italic, 16-18pt

Format : 16:9 (widescreen)
Slides par module : 14 slides exactement
```

---

## STRUCTURE DES 14 SLIDES PAR MODULE

```
Slide 1  — TITRE DU MODULE
           [Numéro du module] | [Titre] | [Pilier X]
           Fond navy, titre gold, sous-titre cream

Slide 2  — OBJECTIF DU MODULE
           "Cette semaine, tu vas comprendre / transformer [X]"
           Icône pilier + texte cream sur navy

Slide 3  — HISTOIRE D'OUVERTURE
           Prénom fictif + situation + accroche
           Photo background (homme, atmosphere masculine)

Slide 4  — LE PROBLÈME / L'ENJEU
           Ce que coûte de ne pas travailler ce pilier
           Couleur accent gold pour les points clés

Slide 5  — CONCEPT 1
           Titre gold / Contenu cream / Exemple concret

Slide 6  — CONCEPT 2
           [même structure]

Slide 7  — CONCEPT 3
           [même structure]

Slide 8  — LES 12 PILIERS — FOCUS
           Carte des 12 piliers avec le pilier actuel mis en évidence

Slide 9  — EXERCICE PRATIQUE
           Format step-by-step, numérotation gold

Slide 10 — DÉFI DE LA SEMAINE
           Grande police, direct, percutant
           "CETTE SEMAINE : [Défi en 1-2 lignes]"

Slide 11 — JOURNAL DE RÉFLEXION
           5 questions numérotées, espace visuel pour notes

Slide 12 — AFFIRMATIONS DE LA SEMAINE
           5 affirmations, une par ligne, gold sur navy

Slide 13 — LA VÉRITÉ FINALE
           1 citation ou vérité puissante — grande police
           Style épuré

Slide 14 — PROCHAINE ÉTAPE
           "Module [N+1] : [Titre]" 
           + Logo Pilier Conscient
           + pilierconscient.com
```

---

## RÈGLES DE GÉNÉRATION PPTX

### Via pptxgenjs (Node.js)

```javascript
// Design tokens
const NAVY = '1A1A2E';
const GOLD = 'C4A35A';
const CREAM = 'F2EDE3';

// NE PAS utiliser de couleurs 8 caractères avec alpha
// pptxgenjs ne supporte pas rgba — utiliser hex 6 caractères uniquement

// Structure slide titre
pptx.addSlide().addText(moduleTitle, {
  x: 1, y: 2, w: 8, h: 2,
  fontSize: 44, bold: true,
  color: GOLD,
  fontFace: 'Calibri'
});
```

### Via Python-pptx (XML)

Utiliser l'approche XML/zip pour un contrôle précis.
Ne pas remplacer le fichier entier — injecter section par section.

---

## PROTOCOLE DE LIVRAISON

### Ce que la skill produit

1. **Contenu des 14 slides** — texte exact pour chaque slide
2. **Notes de présentation** — ce que Prince Johann dit sur chaque slide
3. **Instructions de génération** — code pptxgenjs ou spécifications pour le développeur

### Informations nécessaires

```
1. Numéro du module (1-52)
2. Titre du module
3. Pilier (P1-P12)
4. Contenu du module (si déjà rédigé via skill-module-programme)
5. Format de livraison (contenu seul / code pptxgenjs / spec Python)
```

---

## RÈGLES DE COMPORTEMENT

- **Respecter strictement les 14 slides** — ni plus, ni moins
- **Couleurs en hex 6 caractères** — jamais de rgba ou hex 8 caractères (bug pptxgenjs)
- **1 idée par slide** — jamais surcharger
- **Logo Pilier Conscient obligatoire** en slide 14 et en pied de page optionnel
- **Calibri uniquement** — police de la marque
