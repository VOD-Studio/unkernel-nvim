# Repository Guidelines

## Project Structure

- `index.html` and `src/main.ts` start the browser app. In `src/`, `terminal.ts` handles xterm and PTY I/O, `modal.ts` owns the control center, `vm-manager.ts` manages the unkernel VM and persistent disks, and `fs-bridge.ts` bridges local folders to 9p.
- `server/` contains the Bun app server, standalone Wisp server, gateway, and shared network and security code. `vite.config.ts` provides the same-origin Wisp endpoint during development and preview.
- `scripts/prebake.ts` prepares Linux images and Neovim data disks under `public/`. `public/fonts/` contains the bundled terminal font. Keep generated images and `dist/` out of commits.

## Build, Test, and Development Commands

- `bun install --frozen-lockfile` installs dependencies using `bun.lock`. The project pins Bun 1.4.4 in `package.json`.
- `bun run prebake` prepares both guest environments. Pass `debian` or `alpine` to build one. Install `git`, `curl`, `tar`, `unzip`, and Zig first.
- `bun run dev` runs Vite at `http://localhost:5173` with the same-origin `/wisp` endpoint. Generate the guest assets before testing VM boot.
- `bun run build` runs strict TypeScript checks and builds `dist/`. Use `bun run preview` to preview the build or `bun run start` to serve it through the production Bun entry point.
- `bun run wisp` starts the standalone Wisp service. Configure its server-side `WISP_AUTH_TOKEN` using `.env.example` as a reference.
- `bun test` runs the full test suite.

## Coding Style and Naming

Use two-space indentation, double quotes, and semicolons in TypeScript. Follow existing kebab-case filenames, camelCase functions, and PascalCase types. Keep `.ts` extensions on relative imports and use `import type` for type-only imports. Type-check with `bun run build`.

## Testing Guidelines

Place Bun tests beside the code as `*.test.ts` and use descriptive `describe` and `test` names. Run `bun test src/memory-config.test.ts` for VM memory settings or `bun test server/wisp.test.ts` for Wisp and server security. For terminal changes, switch between Neovim and the guest shell in a browser and verify keyboard and mouse behavior in both sessions.

## Commits and Pull Requests

Make one commit as soon as each feature is complete. Keep each commit focused on that feature.

Use short, imperative commit subjects with the prefixes found in history, such as `feat:`, `fix:`, and `docs:`. In pull requests, describe the behavior change, link related issues, and list the checks you ran. Include screenshots for visible changes and mention any required configuration or image rebuilds.
