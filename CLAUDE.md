# Coding conventions

Follow @CONVENTIONS.md, the canonical coding style for this repo.

## Project structure

- Use the `@/*` path alias for imports that traverse 2+ directory levels (e.g. `@/src/eval/report`); keep single-level relative imports (`../`) as-is.

## Package manager

- This project uses **npm** (not pnpm/yarn). Always use `npm install`, `npm run`, etc.