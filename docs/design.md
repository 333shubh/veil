# Veil design system and site plan

The website is the product's front door: a pop-up paper book about the grid that opens into a live city running the
real protocol. This file is the brief, the brand kit, the tokens and the plan. The tokens live in `demo/tokens.css`;
the visual brand kit is `demo/brand.html` (served at `/brand`).

## Brief

- **Who**: people at Indian power utilities (DISCOMs), regulators and auditors, researchers, and curious residents.
- **The one thing to feel**: "the utility can run the grid without seeing my home", and that it is real: the city
  runs the actual protocol, and every number on the page is traced to an experiment or a source.
- **Constraints**: one static page on Vercel, three.js, no framework. Light theme only. 60 fps on a mid-range laptop,
  usable on a phone, readable with reduced motion and without WebGL.

## Direction

A printed pop-up book. Everything on screen is a piece of paper that was printed, cut, folded or stamped: the city is
card stock, the story cards are a receipt, an index card, a ledger page, a ticket. Colour comes from a riso press with
few inks; type is set big and confident, like a book cover.

- **Palette with jobs**: butter is the ground of the interface, brown is its ink; deep blue sets headlines; print blue
  draws lines; pink is the stamp, used for the one thing that matters in a view; violet means "masked".
- **Type**: Plus Jakarta Sans for everything that speaks, IBM Plex Mono for everything a machine printed.
- **Signature moment**: the book opening, the skyline page standing up behind the city.
- **Motion stance**: paper in your hands (below). Nothing glows, nothing floats.

## Brand

- **Name**: Veil. Always one word, capital V. Never "VEIL" in running text.
- **Line**: *Your neighbourhood's total. Not your home's.*
- **What it is, in one sentence**: Veil lets a power utility read the exact total load of a neighbourhood while every
  home's smart-meter reading stays masked.
- **Mark**: a V folded from two paper strips, one face in print blue and one in pale card, with the red sun between
  them. The fold is the product: two halves that cancel into one total. Use it on butter or paper; on deep blue the
  blue strip prints in soft ink (`#8fa5cf`) and the pale one in paper. Keep a clear space of one strip width around it;
  never recolour the sun.
- **Voice**: plain, specific, measured. Say what was measured and where; say what it does not do. No hype words
  ("revolutionary", "military-grade"), no exclamation marks, numbers with their source.

## Tokens

All in `demo/tokens.css` as CSS custom properties.

| group | tokens |
|---|---|
| ink and ground | `--butter` interface ground, `--butter-2` sky and page, `--brown` interface ink, `--paper` card surface, `--paper-2` inset surface |
| text | `--deep` headlines, `--text` body, `--muted` secondary |
| print | `--ink` line art and links, `--pale` card stock, `--rose` table |
| signal | `--pink` stamp and focus, `--violet` masked values, `--ok`, `--warn`, `--fail` |
| type scale | `--t-xs` 12, `--t-sm` 14, `--t-md` 17 (body), `--t-lg` 21, `--t-xl` 28, `--t-2xl` fluid 34 to 54, `--t-hero` fluid 52 to 128 (ratio 1.25, display fluid) |
| space | `--s-1` 4 to `--s-10` 128 on a 4 px base |
| radius | `--r-paper` 6, `--r-card` 14, `--r-pill` 999 |
| elevation | `--lift` resting paper, `--lift-2` picked up, `--press` the hard pink offset under a stamped button |
| motion | `--d-press` 120 ms, `--d-hover` 200 ms, `--d-panel` 320 ms, `--d-page` 700 ms; `--e-out`, `--e-move`, `--e-paper` |

## Motion: paper in your hands

Unhurried, tactile, settling. Paper is picked up, lands with a small settle, and stays put.
Traits: tactile, settling, legible. Anti-traits: floaty, rubbery, flashy.

| token | value | used for |
|---|---|---|
| `--d-press` | 120 ms | button press, toggle |
| `--d-hover` | 200 ms | hover lift, tab change |
| `--d-panel` | 320 ms | accordions, panels, tags |
| `--d-page` | 700 ms | a card landing, a chapter title |
| `--e-out` | cubic-bezier(.2,.8,.2,1) | entrances |
| `--e-move` | cubic-bezier(.65,0,.35,1) | things moving on screen |
| `--e-paper` | cubic-bezier(.2,1.35,.4,1) | a card landing (small overshoot, the only one allowed) |

- One focal motion per moment: the camera leads, the card follows, the tags come last.
- Scroll drives the story; nothing autoplays except the city's traffic, kites and the paper plane.
- Reduced motion: no smooth scroll, no parallax, no pop-in; cards are simply there, the camera cuts.

## Components

`slip` (base card) with skins `receipt`, `index`, `ledger-page`, `ticket`, `specimen`, `errata`; `pill` (primary,
ghost); `chip`; `stamp`; `kicker` with its numbered tag; `seg` (segmented control); `tag` (3D-anchored label);
`folder` (tabbed paper folder, footer); `faq` (folded note).

## Performance budget

- 60 fps target, 16.6 ms frame; our own JS under 4 ms per frame.
- No layout reads in the frame loop: section geometry is measured on resize; DOM writes are transforms and only when
  a value changed.
- Every shader compiles behind the loader, so nothing hitches mid-scroll.
- Render resolution adapts: it steps down when frames run long and back up when there is headroom.
- Nothing renders while the city is off screen.

## Plan

1. **Smooth** (this round): layout-free frame loop, shader warm-up, adaptive resolution, lighter shadows and MSAA,
   no rendering behind the footer, inertial scrolling (Lenis).
2. **Bigger and bolder** (this round): the type scale above, a full-bleed cover title, larger cards and controls, a
   chapter rail with page numbers.
3. **Interactive** (this round): change a house's reading in the explainer and watch the masks still cancel; measured
   results that count up and tilt like cards in the hand; a footer you can open like a folder.
4. **Product footer** (this round): the back cover. What Veil is, who it is for, a spec sheet with sources, questions
   people ask, project status, and the brand kit.
5. **Next**: a phone pass on a real device; city interactions in the story itself (click a home in "the meter"
   chapter); sound design as an opt-in; an onboarding hint in the live city; merge vehicles into one instanced mesh.
