# Copilot Instructions — By Ismael

## About
"By Ismael" is my personal app-building brand. I build unique, premium, out-of-the-box concept apps
as a solo product factory. Goal: a million-dollar venture.

## My style
- Solo founder — I need to move fast and ship clean
- Premium feel, unique concepts — not generic CRUD apps
- Minimize manual work at every step

## Tech stack
- **Web**: Next.js App Router (TypeScript), Tailwind CSS, shadcn/ui
- **Mobile**: Expo / React Native (TypeScript)
- **Backend**: Supabase (PostgreSQL + Edge Functions + Realtime)
- **Payments**: Lemon Squeezy (subscriptions, one-time, license keys)
- **Deployment**: Vercel (web), EAS (mobile)
- **Monorepo**: Turborepo + pnpm
- **AI**: Anthropic Claude API (claude-sonnet-4-6), OpenAI API

## Coding standards
- TypeScript strict always — no `any`
- Reusable packages in `/packages` (payments, ui, utils, types)
- Lemon Squeezy webhooks always verified with `LEMON_SQUEEZY_WEBHOOK_SECRET`
- One shared `@repo/payments` package reused across all apps
- Mobile: use Expo Router file-based routing
- Animations: Reanimated 3 for mobile, Framer Motion for web

## What I want from Copilot
- When I scaffold a feature, suggest the full stack (DB schema + RLS + API + UI)
- Suggest shared package extractions when code could be reused across apps
- Flag if a pattern would not scale to 10,000 users
- Always suggest optimistic updates for better UX
- Remind me about Lemon Squeezy webhook verification on payment handlers
- Suggest edge cases I might have missed (auth edge cases, race conditions, etc.)

