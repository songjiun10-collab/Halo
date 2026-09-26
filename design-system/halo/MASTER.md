# Design System Master File

> **LOGIC:** When building a specific page, first check `design-system/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file.
> If not, strictly follow the rules below.

---

**Project:** HALO
**Generated:** 2026-09-26 13:39:32
**Category:** Developer Tool / IDE
**Design Dials:** Variance 4/10 (Balanced / Modern) | Motion 3/10 (Subtle) | Density 7/10 (Standard)

---

## Global Rules

### Color Palette

*Hand-edited after generation. The generated navy and green palette was replaced by the neutral graphite palette the frontend uses (`frontend/src/styles/tokens.css`). 85–90% of the screen is neutral, and hue appears only where it carries meaning.*

| Role | Hex | CSS Variable |
|------|-----|--------------|
| App background | `#111214` | `--backdrop` |
| Tab bar | `#191A1D` | `--chrome` |
| Toolbar (selected tab joins it) | `#202124` | `--toolbar` |
| Session panel | `#242528` | `--sidebar` |
| Hover / cards | `#2D2F33` | `--hover`, `--surface` |
| Favicon & avatar tiles | `#383A3F` | `--well` |
| Border (dividers only, 1.4:1) | `#383A3F` | `--border` |
| Control edge (≥3.3:1, added) | `#7D7F84` | `--border-strong` |
| Primary text (warm white) | `#F2F1ED` | `--foreground` |
| Secondary text | `#A6A7AB` | `--muted-foreground` |
| Muted (disabled/decorative only) | `#73757A` | `--text-muted` |
| Primary button fill / text | `#F2F1ED` / `#111214` | `--primary-fill` / `--on-primary` |
| Halo accent, ice (brand, focus) | `#A8C7FA` | `--brand`, `--ring` |
| Ice on the light web page (added) | `#3B6FC4` | `--brand-on-site` |
| Approval, soft amber | `#E5B85C` | `--warning` |
| Blocked, coral | `#E06C67` | `--danger` |
| Success, sage | `#78A980` | `--success` |

**Color Notes:** Graphite first. Ice is for the brand, focus and Claude's cursor; amber means approval is needed; coral means blocked; sage means success. The primary action is neutral, never a hue.

### Typography

- **Heading Font:** JetBrains Mono
- **Body Font:** IBM Plex Sans
- **Mood:** code, developer, technical, precise, functional, hacker
- **Google Fonts:** [JetBrains Mono + IBM Plex Sans](https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap)

**CSS Import:**
```css
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
```

### Spacing Variables

*Density: 7/10 — Standard*

| Token | Value | Usage |
|-------|-------|-------|
| `--space-xs` | `4px` / `0.25rem` | Tight gaps |
| `--space-sm` | `8px` / `0.5rem` | Icon gaps, inline spacing |
| `--space-md` | `16px` / `1rem` | Standard padding |
| `--space-lg` | `24px` / `1.5rem` | Section padding |
| `--space-xl` | `32px` / `2rem` | Large gaps |
| `--space-2xl` | `48px` / `3rem` | Section margins |
| `--space-3xl` | `64px` / `4rem` | Hero padding |

### Shadow Depths

| Level | Value | Usage |
|-------|-------|-------|
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,0.05)` | Subtle lift |
| `--shadow-md` | `0 4px 6px rgba(0,0,0,0.1)` | Cards, buttons |
| `--shadow-lg` | `0 10px 15px rgba(0,0,0,0.1)` | Modals, dropdowns |
| `--shadow-xl` | `0 20px 25px rgba(0,0,0,0.15)` | Hero images, featured cards |

---

## Component Specs

*Hand-edited after generation. The generated specs failed the skill's own checklist: white text on the green button was 2.3:1, the secondary outline was invisible on the dark background, and inputs had `outline: none`. These are the specs `frontend/` uses.*

### Buttons

```css
.hx-btn { min-height: 40px; padding: 0 16px; border-radius: 8px; font-weight: 600;
  transition: transform 160ms cubic-bezier(0.23, 1, 0.32, 1), background-color 150ms ease; }
.hx-btn:active { transform: scale(0.96); }
.hx-btn--primary   { background: var(--primary-fill); color: var(--on-primary); }  /* one per view */
.hx-btn--secondary { background: transparent; color: var(--foreground); border: 1px solid var(--border-strong); }
:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
```

### Cards (approval card)

```css
.hx-approval { padding: 16px; border-radius: 24px; /* 8px buttons + 16px padding */
  background: var(--surface); box-shadow: var(--shadow-raised), inset 0 0 0 1px var(--warning); }
```

### Address field

```css
.hx-omni { height: 40px; border-radius: 20px; background: var(--chrome); border: 1px solid var(--border);
  font-family: var(--font-heading); color: var(--muted-foreground); }
.hx-omni b { color: var(--foreground); } /* the registrable domain */
```

---

## Style Guidelines

**Style:** Dark Mode (OLED)

**Keywords:** Dark theme, low light, high contrast, deep black, midnight blue, eye-friendly, OLED, night mode, power efficient

**Best For:** Night-mode apps, coding platforms, entertainment, eye-strain prevention, OLED devices, low-light

**Key Effects:** Minimal glow (text-shadow: 0 0 10px), dark-to-light transitions, low white emission, high readability, visible focus

### Page Pattern

**Pattern Name:** FAQ/Documentation Landing

- **Conversion Strategy:** Reduce support tickets. Track search analytics. Show related articles. Contact escalation path.
- **CTA Placement:** Search bar prominent + Contact CTA for unresolved questions
- **Section Order:** Hero with search bar > Popular categories > FAQ accordion > Contact/support CTA

---

## Motion

**Scroll Reveal** (Subtle) — Trigger: scroll (viewport enter) | Duration: 300-400ms | Easing: `power1.out`

```js
gsap.from(el, { opacity: 0, y: 12, duration: 0.35, ease: 'power1.out', scrollTrigger: { trigger: el, start: 'top 90%', toggleActions: 'play none none reverse' } });
```

**Framework notes:** Requires the ScrollTrigger plugin registered once via gsap.registerPlugin(ScrollTrigger); Use matchMedia('(prefers-reduced-motion: reduce)') to skip non-essential motion and render the final state immediately

- ✅ Keep the y offset small (8-16px) so it reads as a fade, not a slide
- ❌ Don't reveal below-the-fold content needed for SEO/crawlers as invisible-by-default without a no-JS fallback
- ⚡ toggleActions 'play none none reverse' avoids re-triggering on every scroll direction change

---

## Anti-Patterns (Do NOT Use)

- ❌ Light mode default
- ❌ Slow performance

### Additional Forbidden Patterns

- ❌ **Emojis as icons** — Use SVG icons (Heroicons, Lucide, Simple Icons)
- ❌ **Missing cursor:pointer** — All clickable elements must have cursor:pointer
- ❌ **Layout-shifting hovers** — Avoid scale transforms that shift layout
- ❌ **Low contrast text** — Maintain 4.5:1 minimum contrast ratio
- ❌ **Instant state changes** — Always use transitions (150-300ms)
- ❌ **Invisible focus states** — Focus states must be visible for a11y

---

## Pre-Delivery Checklist

Before delivering any UI code, verify:

- [ ] No emojis used as icons (use SVG instead)
- [ ] All icons from consistent icon set (Heroicons/Lucide)
- [ ] `cursor-pointer` on all clickable elements
- [ ] Hover states with smooth transitions (150-300ms)
- [ ] Light mode: text contrast 4.5:1 minimum
- [ ] Focus states visible for keyboard navigation
- [ ] `prefers-reduced-motion` respected
- [ ] Responsive: 375px, 768px, 1024px, 1440px
- [ ] No content hidden behind fixed navbars
- [ ] No horizontal scroll on mobile
