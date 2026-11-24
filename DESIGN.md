---
name: Night Drift
description: Night neon arcade drift racing in the browser; menus are glass panels over a painted night city.
colors:
  night-0: "#050610"
  night-1: "#07080f"
  night-2: "#0d0f1f"
  night-3: "#151833"
  night-4: "#1e2246"
  ink-0: "#eef0ff"
  ink-1: "#b9bede"
  ink-2: "#8d93b8"
  ink-3: "#5a6088"
  neon-cyan: "#3ef0ff"
  neon-cyan-hi: "#8af7ff"
  neon-rose: "#ff3b6b"
  neon-rose-hi: "#ff7a98"
  timing-amber: "#ffc23d"
  ready-green: "#3dff8a"
  worse-red: "#ff4d5e"
  seat-1: "#3ef0ff"
  seat-2: "#ff3b6b"
  seat-3: "#ffc23d"
  seat-4: "#a77bff"
  seat-5: "#5b8cff"
  seat-6: "#ff8a3d"
  glass-surface: "rgba(10, 12, 24, 0.66)"
  glass-sunk: "rgba(5, 6, 16, 0.6)"
  hairline: "rgba(120, 140, 255, 0.22)"
  hairline-strong: "rgba(150, 160, 255, 0.34)"
typography:
  display:
    fontFamily: "Unbounded, Arial Black, system-ui, sans-serif"
    fontSize: "clamp(36px, 7.4vw, 60px)"
    fontWeight: 800
    lineHeight: 0.95
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Unbounded, Arial Black, system-ui, sans-serif"
    fontSize: "clamp(28px, 5vw, 44px)"
    fontWeight: 800
    lineHeight: 1
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Unbounded, Arial Black, system-ui, sans-serif"
    fontSize: "clamp(22px, 3.2vw, 28px)"
    fontWeight: 800
    lineHeight: 1.05
  body:
    fontFamily: "Manrope, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Manrope, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 700
  number:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Consolas, monospace"
    fontSize: "13px"
    fontWeight: 700
    fontFeature: "tnum"
rounded:
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "22px"
  xl: "28px"
  pill: "999px"
spacing:
  sp-1: "4px"
  sp-2: "8px"
  sp-3: "12px"
  sp-4: "16px"
  sp-5: "24px"
  sp-6: "32px"
  sp-7: "48px"
  sp-8: "64px"
components:
  button-primary:
    backgroundColor: "{colors.neon-cyan}"
    textColor: "{colors.night-1}"
    typography: "{typography.title}"
    rounded: "{rounded.pill}"
    padding: "15px 30px"
  button-ghost:
    backgroundColor: "rgba(255, 255, 255, 0.05)"
    textColor: "{colors.ink-0}"
    rounded: "{rounded.pill}"
    padding: "13px 20px"
  button-pill:
    backgroundColor: "{colors.glass-surface}"
    textColor: "{colors.ink-0}"
    rounded: "{rounded.pill}"
    height: "44px"
    padding: "0 16px 0 12px"
  button-icon:
    backgroundColor: "{colors.glass-surface}"
    textColor: "{colors.ink-0}"
    rounded: "{rounded.pill}"
    size: "44px"
  tile:
    backgroundColor: "{colors.night-3}"
    textColor: "{colors.ink-0}"
    rounded: "{rounded.lg}"
    padding: "8px 8px 16px"
  segmented-radio:
    backgroundColor: "{colors.glass-sunk}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.pill}"
    padding: "4px"
  input-code:
    backgroundColor: "{colors.glass-sunk}"
    textColor: "{colors.ink-0}"
    typography: "{typography.number}"
    rounded: "{rounded.pill}"
    height: "44px"
  map-card:
    backgroundColor: "{colors.glass-sunk}"
    textColor: "{colors.ink-0}"
    rounded: "{rounded.md}"
    padding: "8px 8px 12px"
---

# Design System: Night Drift

This file records the incumbent menu system as it ships on `menu-redesign` before the Plan 3 redesign (tokens in `public/css/tokens.css`, screens in `public/css/screens.css`, older menu rules inline in `public/index.html`). The redesign (U1 onward) keeps the brief in PRODUCT.md and may replace the look described here; update this file when a direction is chosen.

## Overview

**Creative North Star: "A city at night seen from a car"**

Deep blue-black asphalt, glass panels that pick up the street light, and two neon tubes: cyan for "go" (actions, focus) and rose for the brand and for drift. Amber is the timing board: records, laps, the best result. The menus sit directly on a painted night city (silhouettes of houses with lit windows and a wet reflection) under a radial veil, so the content reads as light on a dark street rather than as a web page.

Density is low on the entry screens (home, modes: two or three big tiles and a title) and higher on the working screens (garage, lobby), which are one viewport high with nothing to scroll: a bar on top, a hero element in the middle, controls along the bottom. The intended "one loud thing per screen" is the car on its lit stand in the garage and lobby; the panels around it stay quiet.

**Key Characteristics:**
- Dark-only (`color-scheme: dark`), one deliberate night theme.
- Two neon accents with fixed meanings; amber reserved for times and records.
- Translucent glass panels with a hairline cool-violet border and a 10 px backdrop blur.
- Everything round: pill buttons and switches, wide-cornered cards, round icon buttons.
- Unbounded heavy for names and numbers that matter, Manrope for everything read, JetBrains Mono for every digit.

## Colors

A blue-black night ramp, a cool lavender ink ramp, and saturated neon accents that each carry one meaning.

### Primary
- **Neon Cyan** (`neon-cyan`): actions and focus. The primary button fill (a vertical gradient from `neon-cyan-hi` to `neon-cyan`), focus rings, selected segments and map cards, the stand ring, hover tints at 8–12 % alpha.

### Secondary
- **Neon Rose** (`neon-rose`): the brand and drift. The word «Drift» in the logo, the «Дрифт» mode accent, the map direction arrow and difficulty dots, kick and danger states, error status text.

### Tertiary
- **Timing Amber** (`timing-amber`): records, best laps, the shortcut dashes on blueprints, the host crown, status messages in progress.

### Neutral
- **Night ramp** (`night-0` … `night-4`): page background (`night-1`), wells and tile art grounds (`night-2`), raised gradients (`night-3`, `night-4`).
- **Ink ramp** (`ink-0` text, `ink-1` secondary text and labels, `ink-2` quiet text at 6.6:1 on `night-1` and 5.4:1 on a panel, `ink-3` only for switched-off things).
- **Glass** (`glass-surface` for panels over the scene, `glass-sunk` for wells inside panels) and **hairlines** (`hairline`, `hairline-strong`) in a cool violet.

### Status and seats
- **Ready Green** (`ready-green`): «Готово» and "this car is better". **Worse Red** (`worse-red`): "this car is worse", copy failure.
- **Seat colours** (`seat-1` … `seat-6`): a player's own colour in lists, standings, name tags and the minimap. None equals Ready Green, which rings an avatar on top of its seat colour.

### Named Rules
**The One Meaning Rule.** Cyan means "do this", rose means "brand or drift", amber means "a time or a record". A colour never borrows another's meaning.
**The Light Is Not a Shadow Rule.** Glows (`--glow-action`, `--glow-brand`, `--glow-ready`) are neon light and appear only on the thing that is lit; depth comes from the dark panel shadow.

## Typography

**Display Font:** Unbounded (with Arial Black)
**Body Font:** Manrope (with system-ui)
**Label/Mono Font:** JetBrains Mono (with ui-monospace)

**Character:** Unbounded's wide, heavy geometric forms carry the arcade energy in names (game, screen, car, mode, map); Manrope keeps descriptions and controls calm and legible in Cyrillic; JetBrains Mono with tabular figures makes every time, code and score line up like a timing board.

Loaded weights today: Unbounded 500 and 800, Manrope 400/600/700, JetBrains Mono 500/700. The brief allows Unbounded's full variable range (200–900), which is not yet loaded.

### Hierarchy
- **Display** (800, `clamp(36px, 7.4vw, 60px)`, 0.95): the game name on the home screen only.
- **Headline** (800, `clamp(28px, 5vw, 44px)`, 1): screen titles in the bar, the car name in the garage.
- **Title** (800, `clamp(22px, 3.2vw, 28px)`, 1.05): tile names («Одиночная», «Дрифт»), lobby title, steppers.
- **Body** (400–600, 15 px, 1.55, ≤ 60ch): descriptions and notes; tile descriptions at 13 px, 1.5, ≤ 46ch.
- **Label** (700, 13 px): button text in pills, setting names. HUD labels are 11 px uppercase with 0.14 em tracking (HUD only).
- **Number** (700, 13 px and up, tabular): records, lap times, the room code (0.22–0.3 em tracking), counts.

### Named Rules
**The Every Digit Is Mono Rule.** Any number a player compares (time, score, code, count) is set in JetBrains Mono with tabular figures.

## Layout

Each menu screen is a centred column inside a full-viewport `#menu` layer, max 1080 px wide (1200 px for garage and lobby), with safe-area-aware gutters (`max(16px, env(safe-area-inset-*))`). Spacing follows a 4 px base with roughly doubling steps (`sp-1` … `sp-8`); screen gaps are 24 px, panel padding 16–24 px.

- **Home:** brand block (title + tagline) left-aligned, then a three-tile grid (Одиночная, Онлайн, Карьера), then a collapsible «Управление» panel.
- **Modes:** a bar (round back button + title), a two-tile grid with 21:9 road scenes, then the join-by-code form online.
- **Garage:** one screen high. Bar (back, title, gear, «Карта», «Цвет»), car name and class, the stand (takes what is left, arrows at its sides), stats panel + «Поехали» at the bottom.
- **Lobby:** one screen high. Bar (Выйти, title + mode chip, Авто, Карта), players panel left (250–340 px) and the stand right, a foot row with the code pill, the settings panel and the main button.
- **Map picker:** a popover anchored under «Карта», a three-column grid of map cards (two below 760 px; a bottom sheet with one scrolling row on a sideways phone).

Breakpoints: 960 px (lobby foot wraps), 760 px (tiles stack, lobby players become an avatar strip), 560 px (single column, full-width main buttons, popovers become bottom sheets), and `max-height: 500px` landscape (everything tighter; the stand keeps the height).

## Elevation & Depth

Hybrid: translucent glass over the scene for structure, a large soft dark shadow for lift, and neon glows only on lit elements. Panels blur what is behind them (`backdrop-filter: blur(10px)`) and carry a 1 px inner top highlight.

### Shadow Vocabulary
- **Panel** (`0 30px 80px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.08)`): old-style menu cards (pause, results, crash).
- **Lift** (`0 18px 48px rgba(0,0,0,0.5)`): tiles, popovers, toasts.
- **Action glow** (`0 8px 30px rgba(62,240,255,0.38)`): the primary button.
- **Brand glow** (`0 12px 40px rgba(255,59,107,0.26)`): danger buttons and alert toasts.
- **Ready ring** (`0 0 0 2px #3dff8a, 0 0 18px rgba(61,255,138,0.45)`): a ready player's avatar.
- **Tile accent** (`0 0 0 1px accent, 0 18px 54px -12px accent`): a tile on hover or focus, on its own layer so only opacity animates.

## Shapes

Round everywhere, with small parts tighter than the panels that hold them: chips and swatches fully round, buttons and inputs as pills (999 px), map cards 16 px, tiles 22 px, old menu cards 28 px. Inner art inside a tile is inset by 8 px with the radius reduced to match. Borders are 1 px cool-violet hairlines; dashed hairlines mark empty seats. Blueprints are stroked paths with round caps on a faint grid.

## Components

### Buttons
- **Shape:** pill (999 px).
- **Primary (`.cta`):** Unbounded 800 16 px, night text on a cyan gradient, action glow; hover lifts 1 px and brightens the glow; `aria-disabled` drops to 42 % with no glow; when «Старт» becomes available it flashes once (`cta-arm`, 520 ms); «Готово» pressed turns green with a tick.
- **Ghost:** Manrope 700 14 px on 5 % white with a hairline; hover turns the border cyan.
- **Pill (`.pill-btn`):** 44 px high glass pill with an optional 20 px icon and a word (Цвет, Авто, Карта, Выйти).
- **Icon (`.icon-btn`):** 44 px round glass button with a 22 px stroke icon and an aria label; pressed `scale: 0.94`.

### Tiles (home and modes)
- **Corner Style:** 22 px.
- **Background:** raised glass gradient, hairline border, lift shadow.
- **Content:** an inline SVG illustration (16:10 on home, 21:9 on modes) above a title, a description and, on modes, an amber mono record line.
- **States:** hover rises 5 px and the art zooms to 1.04 while an accent-coloured ring and glow fade in; focus shows the ring plus the cyan outline; disabled («Карьера») is grey with a diagonal «SOON» ribbon.

### Inputs / Fields
- **Room code:** a pill with JetBrains Mono 700, 0.3 em tracking, uppercase, centred; focus turns the border cyan with the cyan outline.
- **Segmented radio (`.seg-radio`):** a sunk pill track; the checked option is a cyan-tinted pill with a cyan border.
- **Stepper:** − and + round icon buttons around a mono output.

### Navigation
- A screen bar at the top of every screen: a round back button (or «Выйти» pill in the lobby), the screen title in Unbounded, then the screen's own pills. Esc goes back. Screens change with a View Transition: the old one slides 24 px and fades, the new one comes 40 px from the side you head to (320 ms ease-out); reduced motion is a short fade.

### Map card (signature)
A blueprint of the track from above on a faint 6 × 5 grid (road in quiet ink brightening to cyan with height, bridges cut out by a dark gap, shortcuts dashed amber, start line, a rose arrow for direction), then the name, length in mono, difficulty as five rose dots, tags, and the player's records on this map. Selected: cyan border and tint plus a round cyan tick.

### Player row (signature)
A 46 px square avatar in the seat colour with the seat number, a crown above the host, a green outer ring when ready; name and car beside it; a ✕ for the host on hover/focus (always on touch). On phones the list becomes a horizontal strip of avatars.

### Car stand (signature)
The car on a round lit podium with a neon cyan edge, drawn by a small separate renderer; dragged sideways it turns with inertia; the car slides 14 % aside when the paint panel opens.

## Do's and Don'ts

### Do:
- **Do** take every colour, space, radius, duration and easing from `tokens.css` tiers 2 and 3.
- **Do** keep cyan for actions and focus, rose for brand and drift, amber for records and times.
- **Do** set every comparable number in JetBrains Mono with tabular figures.
- **Do** give every control a 44 px target on touch (an invisible `::before` grows small ones) and a visible 2 px cyan focus ring with a 3 px gap.
- **Do** animate only `transform`/`translate`/`scale` and `opacity`: hover 170 ms, popovers 190 ms, screens 320 ms, ease-out `cubic-bezier(0.22, 1, 0.36, 1)`; reduced motion keeps the change and drops the travel.
- **Do** keep the garage and lobby one viewport high with no page scroll.

### Don't:
- **Don't** draw the race scene under the menus; the backdrop is the painted city.
- **Don't** add light themes; the system is dark only.
- **Don't** put glows on things that are not lit (labels, panels, quiet text).
- **Don't** use raw hex or px values in screen CSS; add a token instead.
