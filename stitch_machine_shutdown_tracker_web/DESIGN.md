---
name: Precision Industrial Operations
colors:
  surface: '#031427'
  surface-dim: '#031427'
  surface-bright: '#2a3a4f'
  surface-container-lowest: '#000f21'
  surface-container-low: '#0b1c30'
  surface-container: '#102034'
  surface-container-high: '#1b2b3f'
  surface-container-highest: '#26364a'
  on-surface: '#d3e4fe'
  on-surface-variant: '#c6c6cd'
  inverse-surface: '#d3e4fe'
  inverse-on-surface: '#213145'
  outline: '#909097'
  outline-variant: '#45464d'
  surface-tint: '#bec6e0'
  primary: '#bec6e0'
  on-primary: '#283044'
  primary-container: '#0f172a'
  on-primary-container: '#798098'
  inverse-primary: '#565e74'
  secondary: '#7bd0ff'
  on-secondary: '#00354a'
  secondary-container: '#00a6e0'
  on-secondary-container: '#00374d'
  tertiary: '#4edea3'
  on-tertiary: '#003824'
  tertiary-container: '#001c10'
  on-tertiary-container: '#009365'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#dae2fd'
  primary-fixed-dim: '#bec6e0'
  on-primary-fixed: '#131b2e'
  on-primary-fixed-variant: '#3f465c'
  secondary-fixed: '#c4e7ff'
  secondary-fixed-dim: '#7bd0ff'
  on-secondary-fixed: '#001e2c'
  on-secondary-fixed-variant: '#004c69'
  tertiary-fixed: '#6ffbbe'
  tertiary-fixed-dim: '#4edea3'
  on-tertiary-fixed: '#002113'
  on-tertiary-fixed-variant: '#005236'
  background: '#031427'
  on-background: '#d3e4fe'
  surface-variant: '#26364a'
typography:
  display-lg:
    fontFamily: Inter
    fontSize: 3rem
    fontWeight: '700'
    lineHeight: 3.5rem
    letterSpacing: -0.02em
  display-lg-mobile:
    fontFamily: Inter
    fontSize: 2rem
    fontWeight: '700'
    lineHeight: 2.5rem
    letterSpacing: -0.01em
  headline-lg:
    fontFamily: Inter
    fontSize: 1.75rem
    fontWeight: '600'
    lineHeight: 2.25rem
    letterSpacing: -0.01em
  headline-md:
    fontFamily: Inter
    fontSize: 1.25rem
    fontWeight: '600'
    lineHeight: 1.75rem
  body-lg:
    fontFamily: Inter
    fontSize: 1rem
    fontWeight: '400'
    lineHeight: 1.5rem
  body-md:
    fontFamily: Inter
    fontSize: 0.875rem
    fontWeight: '400'
    lineHeight: 1.25rem
  body-sm:
    fontFamily: Inter
    fontSize: 0.75rem
    fontWeight: '400'
    lineHeight: 1rem
  telemetry-kpi:
    fontFamily: JetBrains Mono
    fontSize: 2.25rem
    fontWeight: '700'
    lineHeight: 2.5rem
    letterSpacing: -0.03em
  telemetry-data:
    fontFamily: JetBrains Mono
    fontSize: 0.875rem
    fontWeight: '500'
    lineHeight: 1.25rem
  label-caps:
    fontFamily: Inter
    fontSize: 0.6875rem
    fontWeight: '600'
    lineHeight: 0.875rem
    letterSpacing: 0.08em
  badge-status:
    fontFamily: JetBrains Mono
    fontSize: 0.75rem
    fontWeight: '600'
    lineHeight: 1rem
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  gutter: 1rem
  margin: 1.25rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 0.75rem
  space-lg: 1.25rem
  space-xl: 1.75rem
---

## Brand & Style

This design system is engineered for mission-critical industrial supervision, telemetry, and plant maintenance operations centers. The personality is authoritative, rigorously structured, hyper-legible, and uncompromisingly utilitarian. It establishes an atmosphere of controlled precision, where operators, plant engineers, and shift supervisors can diagnose anomaly states, evaluate machine uptime, and track scheduled overhaul workflows without cognitive fatigue over extended 12-hour shifts.

The design movement synthesizes modern technical minimalism with high-density control-room telemetry. It rejects decorative skeuomorphism and excessive blur in favor of structured data zones, high-contrast status signifiers, and calibrated micro-surfaces. Operational status is immediate, unmistakable, and visible across physical distances on multi-monitor command walls as well as handheld ruggedized tablets on the plant floor.

## Colors

The palette is anchored by deep industrial slate and midnight navy foundations, optimized for dark-mode low-light operations centers while maintaining crisp contrast ratios (WCAG AAA compliant for critical signals).

### Functional Palette
- **Canvas Base**: `#0B0F17` (Deepest chassis black-blue)
- **Surface Level 1**: `#0F172A` (Command slate dark)
- **Surface Level 2**: `#1E293B` (Elevated card/table row surface)
- **Surface Level 3**: `#334155` (Hover states and active containers)
- **Structural Borders**: `#1E293B` and `#334155`

### Progress & Shutdown Telemetry Scale
To communicate machine shutdown, recovery phases, and maintenance progression dynamically:
- **0% (Idle / Unstarted / Offline)**: Slate Gray (`#64748B`) / Background Tint (`#1E293B`)
- **25% (Isolation / Diagnosis / Caution)**: Industrial Amber (`#F59E0B`) / Alert Orange (`#EA580C`)
- **50% (Active Maintenance / Purge / In-Progress)**: Sky Blue (`#38BDF8`) / Technical Cyan (`#0284C7`)
- **75% (Calibration / Pre-Commissioning)**: Indigo Purple (`#818CF8`) / Violet (`#6366F1`)
- **100% (Operational / Online / Certified)**: Emerald Green (`#10B981`) / High-Vis Green (`#059669`)

Text tokens use absolute white (`#F8FAFC`) for primary metric readouts, slate-300 (`#CBD5E1`) for labels and table content, and muted slate-500 (`#64748B`) for units and metadata.

## Typography

Typography prioritizes fast scannability, dense tabular structures, and precise character alignment. `Inter` serves as the primary system face for all structural headings, administrative metadata, and narrative documentation, featuring full native alignment with high-legibility Thai typefaces (`Prompt` or `Sarabun`) via localized fallback stacks: `Inter, "Prompt", "Sarabun", -apple-system, BlinkMacSystemFont, sans-serif`.

For numerical readouts, timestamps, sensor inputs, equipment serial numbers, and progress indicators, the system relies strictly on `JetBrains Mono` with tabular numerals (`tnum`, `zero`). This ensures zero layout jitter when telemetry values refresh in real time.

## Layout & Spacing

The layout is built around a dense 12-column fluid grid system designed to scale from 4K plant-monitoring arrays down to field tablets. 

- **Desktop & Multi-Monitor Command Walls (≥ 1440px)**: 12 columns, 1rem (16px) gutter, 1.25rem (20px) outer canvas margin. High-density packing with dual sidebar panels (fixed equipment hierarchy on left, critical incident queue on right).
- **Workstations & Laptops (1024px – 1439px)**: 12 columns, 0.75rem gutter, 1rem margin. Sub-panels become collapsible drawers or tabs.
- **Rugged Field Tablets (768px – 1023px)**: 6 columns, fluid stacking, sticky batch-action controls.
- **Mobile Handhelds (< 768px)**: 4 columns, single-column reflow, tabular layouts convert automatically into modular metric cards.

Vertical rhythm respects a strict 4px/8px micro-grid to align tabular rows, KPI tiles, and telemetry sparklines across adjacent dashboard columns.

## Elevation & Depth

This design system avoids theatrical drop shadows and hazy blurs in favor of architectural surface stratification and technical perimeter lighting:

- **Base Canvas (`#0B0F17`)**: Ground layer housing global background grids and telemetry canvases.
- **Container Tiers (`#0F172A` to `#1E293B`)**: Standard cards, table viewports, and navigation strips are recessed or flat-mounted using crisp 1px borders (`#334155` or `#1E293B`) with no blur.
- **Active Operational Focus**: Modals, slide-out diagnostic sheets, and flyout overrides employ a hard inset ambient shadow: `0 4px 20px -2px rgba(0, 0, 0, 0.75), 0 0 0 1px #475569`.
- **Live Anomaly Highlights**: Alert states leverage 1px high-luminance keyline borders paired with a faint 6px colored perimeter glow (e.g., `#EA580C` at 20% opacity) to immediately pull the operator's eye to failing hardware modules.

## Shapes

The shape system adopts a disciplined, low-radius engineering form factor (`Soft`, 0.25rem base radius). Corner curves are intentionally tight to maintain high data density, mimic rugged hardware instruments, and maximize printable screen space in compact tables and telemetry matrices. 

- Standard inputs, metric cards, and table rows use `0.25rem` (4px).
- Modals, flyout panels, and large grouping containers use `0.5rem` (8px).
- Status pills, inline tags, and state indicators maintain strict rectangular caps with `0.25rem` corners or sharp chamfers—pill-shaped rounded bubbles are strictly forbidden to prevent an uncalibrated, consumer-app appearance.

## Components

### KPI Metric Tiles
Constructed with `#0F172A` background, 1px `#1E293B` border, and 4px corner radius. The top line displays an uppercase tracking label (`label-caps`) in `#64748B`, followed by a bold monospace metric (`telemetry-kpi`) in white or current status hue. The bottom baseline contains delta trends and secondary timestamps.

### Status Badges & Real-Time Indicators
Badges feature an opaque background tint at 15% opacity matching the status token, a 1px solid border at 40% opacity, and sharp monospace text (`badge-status`). Real-time live status nodes include a 6px solid dot with an optional CSS ping animation for active emergency shutdown (ESD) events.

### Step-Progression & Interactive Progress Meters
Progress indicators feature a segmented 5-phase bar (0%, 25%, 50%, 75%, 100%) rather than an ambiguous continuous gradient. Each segment reflects its discrete phase color:
- Gray for pending
- Amber for locked/tagged out
- Sky Blue for physical teardown/repair
- Indigo for loop-checks and calibration
- Emerald for ready-to-run certification

### High-Density Data Tables
Rows use a fixed 40px height in compact mode and 48px in comfortable mode. Alternating subtle striping (`#0F172A` vs `#131D31`) with a 1px bottom border in `#1E293B`. Hover states highlight the entire row in `#1E293B` with a 2px left accent border indicating current row focus. Numbers and status codes right-align in monospace.

### Inputs & Controls
Inputs use `#0B0F17` surface backings, 1px `#334155` borders, and `#F8FAFC` text. On focus, borders transition to `#38BDF8` with a 1px non-diffused keyline ring. Buttons use solid high-contrast dark fills with sharp corners, while emergency stop and trip-circuit actions feature high-visibility `#EF4444` borders with diagonal safety-stripe micro-headers.