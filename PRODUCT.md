# Product

<!-- impeccable:product-schema 1 -->

Recorded by the nd-ui agent from the repository (README.md, docs/PLAN-3.md, the code) and the coordinator's brief. No live interview was possible in this run; facts marked *(inferred)* come from the brief and the code, not from the owner, and should be confirmed.

## Platform

web

A static site (`public/`) plus a Node.js Colyseus server (`server/`). Played in a desktop browser with a keyboard and in a phone browser with on-screen touch buttons, upright and sideways. No native wrapper.

## Users

- **Primary:** Russian-speaking players who open the game in a browser for a quick session of arcade driving at night: alone, chasing their own lap and score records, or online with friends in a room of up to six. All interface copy is Russian.
- **The friend who was sent a link:** arrives by `?room=КОД` or a four-letter code, needs to get from the link into the lobby and onto the grid with as few steps as possible. *(inferred from the join flow and the brief's "invite link in one tap")*
- **Devices:** desktop (keyboard: WASD/arrows, Space handbrake, Tab/Enter/Esc in menus) and phones (touch buttons ГАЗ, ТОРМ, ДРИФТ, ◀ ▶), both orientations.

## Product Purpose

Night Drift is a browser 3D arcade racing game about drifting through a neon city at night. It exists so a player can be driving within seconds of opening a link, and so friends can share one start and compare results. Success: the run starts fast, the car feels right, and the path from the first screen to the grid is something a player wants to show a friend (Plan 3, part 2).

## Positioning

A real 3D drift game that runs in the browser with no install, where solo play and online rooms with friends share the same two modes, the same cars and the same server-timed results. The server decides everything that affects the result (start moment, lap times, finish order), so a lap time means the same thing for everyone in the room.

## Operating Context

- **Modes:** «Дрифт» (track; six maps: Ночной город, Эстакада, Серпантин, Паркинг, Перевал, Развязка; laps 1–10) and «Трасса» (an endless four-lane highway with traffic; near-miss scoring, combo up to ×5; online it is timed, 1–10 minutes, traffic density low / mid / high).
- **Path a player walks:** home (Одиночная / Онлайн / Карьера, the last one not yet available) → mode choice («Дрифт» or «Трасса», with records; online also a join-by-code form) → map choice (drift only) → garage (car, paint, run settings) → lobby (online) → countdown and the run → results or crash screen.
- **Cars:** 8 cars in 6 classes (GT, JDM, Маслкар, Суперкар, Седан, Ралли), each with its own 3D model; 11 paints (factory plus 10). Stats differ by a few percent and every strength has a cost.
- **Online rooms:** up to 6 players; host first with a crown; a fixed seat order and six seat colours; host picks map, laps or minutes and density; others press «Готово»; host kicks with a confirmation; names are edited in place.
- **Records:** kept in the browser, per map for drift, one for the highway.
- **Sessions are short and repeatable:** Space or Enter restarts after a crash; results lead straight to the next run or back to the lobby.

## Capabilities and Constraints

- Plain HTML, CSS and ES modules. No framework, no bundler. three.js r128.
- Fonts: Unbounded (display), Manrope (text), JetBrains Mono (numbers), loaded from Google Fonts.
- Test-bound element ids in `public/index.html` (`tests/garage`, `tests/lobby`, `tests/stand`, `tests/perf`) must be kept.
- The race scene is not drawn under the menus; the menu backdrop is a painted night city, and the garage and lobby draw only the small car stand. `test:perf` guards this and 60 fps in the menu.
- New menu assets total at most 2 MB; videos load lazily; the first screen never waits for video (Plan 3, part 2).
- Online server is on Render's free tier and may need to wake up. *(from PLAN-3, part 1)*
- **Undecided:** «Карьера» is announced as «Скоро: сезон заездов и свой гараж» with no content behind it yet.

## Brand Commitments

Binding brief (from `.claude/agents/nd-ui.md` and docs/PLAN-3.md; do not change):
- Night neon arcade. Brand cyan `#3ef0ff` and rose `#ff3b6b`; dark translucent glass panels.
- Fonts Unbounded (variable 200–900), Manrope, JetBrains Mono.
- Russian copy. Mode names are exactly «Дрифт» (track) and «Трасса» (traffic).
- The menu is a window into the game itself: everything shown is made by the real engine (real cars, real tracks, real street light). No abstract illustrations, stock gradients or decorative highlights for their own sake.
- Name: Night Drift (Latin letters in the logo; the word «Drift» in rose).

## Evidence on Hand

- The game itself: real 3D car models in `public/models/cars/`, six drift maps as data in `public/js/modes/track/maps/`, the highway in `public/js/modes/traffic/`, map blueprints drawn from geometry (`public/js/ui/mapPicker.js`).
- The painted menu backdrop city in `public/js/core/render.js`.
- No testimonials, player counts, press, ratings or leaderboards exist. Records are per-browser only. Future work must not invent any of these.

## Product Principles

1. **From link to grid fast.** Every screen on the path either gets the player closer to driving or explains something they need for it; nothing waits on decoration.
2. **Show the game, not a picture of it.** What the menu shows comes from the engine and the real data (maps, cars, records).
3. **Solo and online are one game.** Same modes, same cars, same results screens; online adds the room, not a different product.
4. **The result is honest.** Times and finish order come from the server; records shown are the player's own.
5. **Keyboard and thumb are equal.** Every action works with Tab/Enter/Esc/arrows and with a 44 px touch target, upright and sideways.

## Accessibility & Inclusion

- Text contrast ≥ 4.5:1, visible focus, aria labels on icon buttons, keyboard navigation (Tab, Enter, Esc, ← →).
- Touch targets ≥ 44 px; no horizontal scroll at 390 px.
- `prefers-reduced-motion` respected: instant changes without loss of information; `Save-Data` shows posters instead of video.
