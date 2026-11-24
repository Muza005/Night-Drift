---
name: Night Drift
description: Night neon arcade drift racing in the browser; the menu is your car on a wet night street with a strip of slanted cards under it («Стойка»).
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
  headline:
    fontFamily: "Unbounded, Arial Black, system-ui, sans-serif"
    fontSize: "clamp(28px, 5vw, 44px)"
    fontWeight: 800
    lineHeight: 1.05
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Unbounded, Arial Black, system-ui, sans-serif"
    fontSize: "clamp(22px, 3.2vw, 28px)"
    fontWeight: 800
    lineHeight: 1.05
  card-name:
    fontFamily: "Unbounded, Arial Black, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 700
    lineHeight: 1.15
  bar-title:
    fontFamily: "Unbounded, Arial Black, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 700
    lineHeight: 1
  body:
    fontFamily: "Manrope, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.4
  label:
    fontFamily: "Manrope, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 700
  number:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Consolas, monospace"
    fontSize: "13px"
    fontWeight: 700
    fontFeature: "tnum"
  countdown:
    fontFamily: "Unbounded, Arial Black, system-ui, sans-serif"
    fontSize: "clamp(120px, 30vmin, 280px)"
    fontWeight: 800
    lineHeight: 1
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
    height: "56px"
  button-primary-off:
    backgroundColor: "{colors.glass-surface}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.pill}"
  button-ready:
    backgroundColor: "{colors.ready-green}"
    textColor: "{colors.night-1}"
    rounded: "{rounded.pill}"
  button-pill:
    backgroundColor: "{colors.glass-surface}"
    textColor: "{colors.ink-0}"
    typography: "{typography.body}"
    rounded: "{rounded.pill}"
    height: "44px"
  button-icon:
    backgroundColor: "{colors.glass-surface}"
    textColor: "{colors.ink-0}"
    rounded: "{rounded.pill}"
    size: "44px"
  deck-card:
    backgroundColor: "{colors.night-2}"
    textColor: "{colors.ink-1}"
    typography: "{typography.card-name}"
  seat-card:
    backgroundColor: "{colors.night-3}"
    textColor: "{colors.ink-0}"
    typography: "{typography.body}"
  run-panel:
    backgroundColor: "{colors.glass-surface}"
    textColor: "{colors.ink-0}"
    rounded: "{rounded.lg}"
    padding: "8px 16px"
  map-plate:
    backgroundColor: "{colors.glass-surface}"
    textColor: "{colors.ink-0}"
    rounded: "{rounded.md}"
    padding: "4px 16px 4px 4px"
  popover:
    backgroundColor: "{colors.night-3}"
    textColor: "{colors.ink-0}"
    rounded: "{rounded.lg}"
    padding: "16px"
---

# Design System: Night Drift

The shipped menu system on `menu-redesign` after Plan 3, part 2 (U1–U5), direction D2 «Стойка». Tokens live in `public/css/tokens.css`; the menu screens in `public/css/screens.css`; the in-race HUD, the countdown and the old card screens (pause, results, crash) are still styled inline in `public/index.html`.

## Overview

**Creative North Star: "Your car on the street, the night in front of it"**

The menu is a window into the game, not a website over it. Every screen that matters puts the player's own car (the real 3D model, in its paint) on the wet street of the painted night city, under two street lamps, with its reflection in the asphalt. What you choose comes as a strip of slanted cards under the car, the way a racing game's front end does it (Blur is the reference): the card in focus opens wide in the middle and plays a loop recorded from the game; the others stay narrow and dim. The light on the street takes the colour of the card in focus.

There is very little text. Names are short, descriptions are one line or none, and the side areas of a screen are filled by the street, the car and the cards, never by paragraphs. One loud thing per screen: the car (home, lobby) or the car on its lit podium (garage); everything else is glass and hairlines.

**Key Characteristics:**
- Dark only (`color-scheme: dark`), one night.
- The player's car on the street is the hero of home and lobby; the garage puts it on a studio podium under a lamp.
- Slanted cards (a parallelogram via `clip-path`) for every choice on the path: modes, maps, rooms, seats.
- Cyan means "go", rose means the brand and drift, amber means a time or a record.
- Unbounded for names, Manrope for anything read, JetBrains Mono for every digit.
- Motion explains: cards open as focus reaches them, decks roll to the side you are heading, the menu dissolves into the race and the camera swings to the grid.

## Colors

A blue-black night ramp, a cool lavender ink ramp, and neon accents that each carry one meaning.

### Primary
- **Neon Cyan** (#3ef0ff): actions and focus. The main button (a gradient from `neon-cyan-hi` down to it), focus rings, the selected segment, the selected map, the «Трасса» card's light, the copy and invite icons, hover tints at 6–12 % alpha.

### Secondary
- **Neon Rose** (#ff3b6b): the brand and drift. «Drift» in the logo, the «Дрифт» card's light and bar, the map cards, the direction arrow on a track diagram, kick and danger.

### Tertiary
- **Timing Amber** (#ffc23d): records and times: the cup and record on a card, the host's crown, the countdown digits, shortcut dashes on diagrams, «С друзьями»'s light.

### Neutral
- **Night ramp** (`night-0` … `night-4`): the sky, wells behind diagrams (`night-1`), card grounds (`night-2`), raised popovers (`night-3` → `night-1`).
- **Ink ramp**: `ink-0` text; `ink-1` secondary text, figures and resting card names; `ink-2` quiet text (6.6:1 on night-1); `ink-3` only for switched-off things («Карьера», a free seat's number).
- **Glass** (`glass-surface` for panels and pills over the street, `glass-sunk` for wells) with `hairline` / `hairline-strong` borders in cool violet and a 10 px backdrop blur.

### Status and seats
- **Ready Green** (#3dff8a): «Готово» (the pressed button, the bar under a ready seat, its sweep of light) and "this car is better" on a stat bar. **Worse Red** (#ff4d5e): "this car is worse", a failed copy.
- **Seat colours** (`seat-1` … `seat-6`): a player's colour for their seat card's top edge, number and light pool, standings and minimap. The seat number is lifted 16 % toward white so rose and blue hold 4.5:1 on the card.
- **Difficulty**: three bars, green / amber / red by level.

### Named Rules
**The One Meaning Rule.** Cyan means "do this", rose means "brand or drift", amber means "a time or a record". A colour never borrows another's meaning.
**The Light Comes From The Card Rule.** The street's coloured light is the focused card's accent; nothing else tints the scene.

## Typography

**Display Font:** Unbounded (with Arial Black)
**Body Font:** Manrope (with system-ui)
**Number Font:** JetBrains Mono (with ui-monospace)

**Character:** Unbounded's wide heavy forms carry the arcade voice in names (car, mode, map, the game); Manrope keeps the few lines of text calm in Cyrillic; JetBrains Mono with tabular figures makes every time, code and length read like a timing board.

Loaded: Unbounded 500/800, Manrope 400/600/700, JetBrains Mono 500/700 (Google Fonts, `display=swap`).

### Hierarchy
- **Countdown** (800, `clamp(120px, 30vmin, 280px)`, amber; «Старт!» smaller in cyan): the only display-size type, during the start.
- **Headline** (800, `clamp(28px, 5vw, 44px)`): the car's name in the garage.
- **Title** (800, `clamp(22px, 3.2vw, 28px)`): the car's name over the street in the lobby; 18 px on a phone.
- **Bar title** (700, 15 px): «Night Drift» on home (800, 18 px), «Дрифт» / «Лобби» next to «‹» in the bar.
- **Card name** (700, 13 px at rest in `ink-1`, 15 px in `ink-0` when the card is in focus): deck cards, seat names (Manrope 700 13 px, whole, up to two lines).
- **Body** (600, 13 px): the car's one line in the garage (one line from 1024 px up), stat names, panel row names.
- **Label** (700, 11 px): the class chip, «Свободно», «вы», the copy bubble, the key row.
- **Number** (700, 11–20 px, tabular): lengths, records, the room code (0.22 em tracking), laps, stat deltas.

### Named Rules
**The Every Digit Is Mono Rule.** Any number a player compares is JetBrains Mono with tabular figures.
**The Whole Name Rule.** A player's or map's name is never cut with "…": it takes a second line or the layout gives it room.

## Layout

Three full-viewport screens, no page scroll: home (`#pHome`), garage (`#pGarage`), lobby (`#pLobby`). Gutters are the safe-area tokens `--top/--bot` (14 px + inset) and `--lft/--rgt` (≥ 16 px). Spacing is the 4 px ramp `sp-1` … `sp-8`.

- **Home:** the bar on top (logo, or «‹» + level name), the street with the car filling the middle (the stand's box covers the whole screen behind), the deck along the bottom (`--deck-h: clamp(150px, 30vh, 330px)`), and a key row (← → Enter Esc) that appears only once the keyboard is used. Levels: home (Дрифт, Трасса, С друзьями, Карьера) → maps (six diagram cards) / friends (Создать комнату, Войти по коду, with the code field docked above the deck) → room mode.
- **Deck placement:** if the whole strip fits it is centred as one piece; otherwise the card in focus is brought to the middle with the ends kept on screen. Card at rest `clamp(150px, 13vw, 240px)`, open `clamp(340px, 34vw, 600px)` (≤ 62 vw).
- **Garage:** bar (‹, mode title, the map plate for solo «Дрифт», gear, «Цвет»), the car's name and one line, the podium (takes what is left, ‹ › at its sides), the stat bars panel and «Поехали» at the bottom.
- **Lobby:** bar (Выйти, «Лобби» + mode chip, code pill, Авто), the street with my car on the left two thirds, the car's name, the seat strip along the bottom; on the right one run panel (`--lob-side: clamp(300px, 24vw, 360px)`) with the main button under it.

Breakpoints: 1100 px (lobby panel 300 px, seats narrower), 760 px (phone upright: one column; deck cards 84 px with names only on the open one; lobby seats scroll sideways, 132 px; a guest's bar title becomes the mode), 560 px (garage stats in one column, popovers become bottom sheets, the map plate takes its own row), `max-height: 500px` landscape (deck 132 px; lobby panel 280 px, seats 120 × 84 px with the car line hidden; titles and tags give their height to the car).

## Elevation & Depth

Depth is the scene's: the car stands in space on the street with a contact shadow and a reflection; the UI floats over it as glass. Panels blur what is behind (`blur(10px)`) and carry a hairline; raised popovers get the lift shadow. Glows are light, on lit things only.

### Shadow Vocabulary
- **Lift** (`0 18px 48px rgba(0,0,0,0.5)`): popovers, the note toast.
- **Action glow** (`0 8px 30px rgba(62,240,255,0.38)`): the main button only.
- **Ready glow** (`0 8px 30px rgba(61,255,138,0.35)`): «Готово» pressed; `0 0 14px` on the ready bar under a seat.
- **Brand glow** (`0 12px 40px rgba(255,59,107,0.26)`): danger buttons, alert notes.
- **Text over the scene** (`0 1px 12px rgba(0,0,0,0.7)`): every title and line set directly on the street.

## Shapes

Two families. **Slanted:** deck cards and seat cards are parallelograms (`clip-path`), leaning 26 px (deck) and 18 px (seats), overlapping by the slant so the strip reads as one piece; a seat card's 1 px edge is its own colour showing round a fill clipped 1 px smaller. **Round:** everything you press that is not a card: pill buttons (999 px), round icon buttons, the code pill, the run panel (22 px), the map plate (16 px), popovers (22 px), wells (8–12 px). Track diagrams are stroked paths with round caps.

## Components

### Buttons
- **Main (`.cta`):** Unbounded 800, night text on a cyan gradient, action glow. Hover (fine pointers only) lifts 1 px; press `scale(0.97)` in 100 ms. «Старт» while not everyone is ready: a dark glass pill with quiet text (`aria-disabled`, still focusable, says why); when it becomes available it flashes once (520 ms). «Готово» pressed: green with a tick.
- **Pill (`.pill-btn`):** 44 px glass pill, 20 px stroke icon + word (Выйти, Авто, Цвет, Сменить); words drop on a phone, the icon stays with its aria label.
- **Icon (`.icon-btn`):** 44 px round glass button, 22 px stroke icon, aria label; press `scale(0.94)`.
- Every pressable has a 2 px cyan focus ring with a 3 px gap; on touch screens an invisible `::before` grows anything drawn smaller than 44 px.

### Deck card (signature)
A slanted card with its picture: a loop from the game (`<video muted playsinline loop preload="none">` with a WebP poster; sources are added on first focus; posters only with reduced motion or Save-Data), a still, or for a map its diagram drawn from the real centre line with a dot running the lap. At rest: dim (40 %), name in `ink-1`. In focus: opens wide, full picture, name in `ink-0`, a 3 px bar and a round chevron in its accent, its figures (record with a cup, length, difficulty). A focus-visible card thickens the bar to 5 px. Tap or Enter goes in; tap another card or ← → moves focus; a swipe or the wheel moves it too.

### Map plate
In the garage bar and the lobby panel: the map's diagram (it flies there from the map card with a shared View Transition), its name, length and difficulty. A click opens the map picker (a grid of map cards with diagrams, tags and the player's records; a bottom sheet on a phone).

### Stat bars
Five bars in one glass panel. A new car: each bar runs from the old value to the new one (360 ms, 30 ms apart); the difference shows as a green (better) or dim red (worse) layer with a mono delta.

### Seat card (signature)
A slanted card per seat: the number in the seat colour (lifted), the host's crown, «вы» on my own seat, the player's car as a side silhouette in its paint on a pool of the seat's light, the whole name (up to two lines) and the car. Ready: a green bar grows along the bottom and one band of green light sweeps the card. My name is a button: rename in place (a pencil shows on hover/focus). The host gets a ✕ on others (always visible on touch) with a confirm. The first free seat invites: «Позвать» copies the room link in one tap.

### Run panel
One glass panel: title «Заезд», the mode switch (host only; a guest sees the mode in the bar instead), the map plate, laps or minutes (− / + for the host, the value for guests), traffic density, «Призраки». The main button sits under it.

### Motion
- Tokens: `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)`; press 100 ms, hover 170 ms, popover 190 ms in / 120 ms out, card focus 220 ms, screen 320 ms, stat bars 360 ms.
- Screen to screen: View Transitions; the old screen slides 24 px and fades in 170 ms, the new one comes 40 px from the side you head to in 320 ms. A map's diagram flies into the garage bar.
- Deck to deck: the old deck leaves toward where you came from while the new one arrives from the other side (320 ms), the street's layers shift with it.
- The car: a spring (no overshoot) slides the podium out and the next one in, interruptible mid-way; a band of light sweeps a car as it settles; a new paint flows across the body.
- Into the race: the menu dissolves over the last frame (320 ms), the camera swings from the street view to the chase position (1.1 s, ease-out) while the countdown lands each digit with its beep.
- Reduced motion: decks cross-fade, screens fade, no slides, no flows, no camera flight, no loops (posters), no countdown pop; every state still changes.

## Do's and Don'ts

### Do:
- **Do** take every colour, space, radius, duration and easing from `tokens.css` tiers 2 and 3.
- **Do** keep the player's car and the street as the hero; put choices in the slanted strip under it.
- **Do** keep text short: a name, a number, at most one line.
- **Do** give every control a 44 px target on touch and a visible cyan focus ring; keep ← → Enter Esc working on every level.
- **Do** animate `transform`, `scale`, `translate` and `opacity`; exits faster than entrances; gate hover effects behind `(hover: hover) and (pointer: fine)`.
- **Do** check 1440, 390 × 844 and 844 × 390 with no horizontal scroll.

### Don't:
- **Don't** draw the race scene under the menus (`test:perf` guards it); the backdrop is the painted city and the small stand renderer.
- **Don't** fill side areas with text, add eyebrow labels, number non-sequences, or put an arrow in every button.
- **Don't** cut names with "…".
- **Don't** add light themes or glows on things that are not lit.
- **Don't** load videos before a card is focused, or make the first screen wait for one; new menu assets stay ≤ 2 MB in total (now ≈ 0.95 MB).
