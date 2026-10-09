# Naming Conventions

These rules govern how we name files and symbols in **libryva-monorepo**. Apply them whenever you create a new file or add new code. The monorepo contains three languages plus a TypeScript extension app: **Rust** (`apps/server`), **Dart/Flutter** (`apps/libryva`), **Astro** (`apps/website`), and **TypeScript/WXT** (`apps/web-extension`).

## Rust

Applies to `apps/server` (and any future Rust crates in the repo).

- Follow standard Rust nomenclature (the [Rust API Guidelines](https://rust-lang.github.io/api-guidelines/naming.html)) — no project-specific overrides.
  - Files & modules: `snake_case` (e.g. `health.rs`, `audio_metadata_extraction.rs`).
  - Types, traits, enums: `PascalCase` (e.g. `AppState`, `LibraryId`).
  - Functions, methods, variables, fields: `snake_case`.
  - Constants & statics: `SCREAMING_SNAKE_CASE`.
  - Crate: `snake_case` (or `kebab-case` in `Cargo.toml`'s `name`), prefixed with the project name — e.g. `libryva-server`.
  - Modules grouped in a folder use `mod.rs` (e.g. `module/mod.rs`, `shared/mod.rs`).
  - Migrations: `<version>_<snake_case_description>.sql`, matching the existing files in `apps/server/migrations/`.

## Dart / Flutter

Applies to `apps/libryva`. Standard Dart conventions (`dart format` / `flutter_lints`) apply throughout.

- Everything — files, folders, libraries, packages: `snake_case` (e.g. `audiobook_repository.dart`, `audio_playback/`).
- Classes, enums, typedefs, extensions: `PascalCase` (e.g. `AudiobookRepository`, `SleepTimerSession`).
- Variables, functions, methods, named parameters: `camelCase`.
- Constants: `camelCase` (Dart style — no `SCREAMING_SNAKE_CASE`, even for compile-time constants).
- Private members & files: `_leading_underscore` (e.g. `_audiobook_screen_state.dart`).
- Generated files keep their generator suffixes: `*.g.dart` (drift/riverpod), `*.freezed.dart`.

### File naming by role

Files are named after what they contain, singular for single-entity files:

- Models (one class per file): `<entity>.dart` — e.g. `audiobook.dart`, `chapter.dart`, `playlist.dart`.
- Repositories / DAOs / DTOs (`features/<name>/data/`): `<entity>_repository.dart`, `<entity>_dao.dart`, `<entity>_dto.dart`.
- Providers (`features/<name>/providers/`): `<feature>_providers.dart` for the barrel; specific ones `snake_case` by topic — e.g. `audio_player_store.dart`, `theme_persistence.dart`.
- Services (`features/<name>/services/`): `<name>_service.dart` — e.g. `import_service.dart`, `media_scanner_service.dart`.
- Screens (`modules/<screen>/`): `<screen>_screen.dart` (e.g. `home_screen.dart`), with screen-local widgets in `widgets/`.
- Shared widgets (`shared/widgets/`): `snake_case` by component — e.g. `themed_text.dart` (class `ThemedText`).
- Extensions: named after the extended type — e.g. `string_extensions.dart`, `context_extensions.dart`.
- Tests mirror `lib/` structure under `test/`, files suffixed `_test.dart` (e.g. `test/features/audiobooks/data/audiobook_repository_test.dart`).

### Structure (binding)

```
lib/
  app/                    # root widget + go_router config
  modules/<screen>/       # presentation: <screen>_screen.dart + widgets/
  features/<name>/        # business logic: models/ data/ providers/ services/ widgets/
  shared/                 # cross-cutting: constants/ database/ extensions/ logging/ storage/ theme/ utils/ widgets/
```

Screens never import from other modules; they compose via `features/` and `shared/`.

## Astro

Applies to `apps/website` (static site, no islands — see `apps/website/AGENTS.md`).

### Components & layouts

`.astro` components and layouts use **PascalCase** file names matching the exported component:

- `components/Button.astro`, `components/FeatureCard.astro`, `components/StoreBadges.astro`
- `layouts/BaseLayout.astro`, `layouts/ProseLayout.astro`

### Pages

Routes are **kebab-case**, matching the URL they serve:

- `pages/index.astro`, `pages/404.astro`, `pages/blog/[slug].astro`
- Multi-word routes: `pages/legal/privacy-policy.astro` → `/legal/privacy-policy/` (kebab-case slugs, never spaces or underscores).

### Content collections

Content files (`.md`) use **kebab-case** slugs — the slug becomes the URL:

- `content/blog/designing-the-data-layer.md`
- `content/legal/privacy.md`

### TypeScript (config & endpoints only)

TypeScript appears only for site config and build-time endpoints; use **camelCase** file names:

- Config modules: `config/site.ts`, `config/icons.ts`, `content.config.ts`
- Endpoint handlers: `<name>.<ext>.ts` — e.g. `pages/rss.xml.ts`

Identifiers follow standard TS casing: `camelCase` for variables/functions, `PascalCase` for types/interfaces (e.g. `IconName`).

## TypeScript (all TS apps & packages)

Applies to **every TypeScript codebase in the monorepo**: `apps/web-extension`, `apps/dashboard`, `apps/mcp_server`, and `packages/*` (`ui`, `shared`, `api-client`). (For `apps/website`, see the Astro section above — TS there is config/endpoints only.)

- Files: normal TypeScript (`.ts`) files use a **camelCase base name** plus an optional dot-suffix service name — `<name>.<service>.ts`, where `<service>` is one of `utils`, `constants`, `store`, `api`, `types`, `service`, `test` (e.g. `chatCrypto.utils.ts`, `session.store.ts`). **`kebab-case` is reserved for React components (`.tsx`) only** (e.g. `article-card.tsx`); folders stay `kebab-case`. Framework-fixed names are exempt: WXT entrypoints (`popup/`, `background.ts`, `app/`), TanStack Router route files (`src/routes/**` — `_auth.tsx`, `login.tsx`, `bookmarks.$bookmarkId.tsx`, …) and its generated `routeTree.gen.ts`, app entries (`main.tsx`), and ambient declarations (`vite-env.d.ts`).
- File names carry a role suffix — one role per file:
  - React components: `<name>.tsx` — the **only** kebab-case files (e.g. `article-card.tsx`).
  - React hooks: `useHookName.ts` — the file name is the hook's name verbatim (`use` prefix + PascalCase), never kebab-case and never a role suffix (e.g. `useSavedArticles.ts` for `useSavedArticles`, `useMe.ts` for `useMe`). Hooks are the one `.ts` family exempt from the service-suffix rule.
  - Constants & query keys: `<name>.constants.ts` (e.g. `readingProgress.constants.ts`, `mfa.constants.ts`).
  - Utils / helpers: `<name>.utils.ts` (e.g. `chatCrypto.utils.ts`, `articleClassify.utils.ts`).
  - API modules (endpoint wrappers / typed clients): `<name>.api.ts` (e.g. `savedArticles.api.ts`).
  - Shared types & interfaces: `<name>.types.ts` (e.g. `article.types.ts`, `savedArticle.types.ts`).
  - Effect `Context.Service` definitions: `<name>.service.ts` (e.g. `libraryStore.service.ts`).
  - Zustand stores: `<name>.store.ts` (e.g. `session.store.ts`).
  - Tests: `<name>.test.ts`, colocated next to the module they cover (e.g. `classify.test.ts`).
- React components: `PascalCase` exports matching the file name (e.g. `ArticleCard` in `article-card.tsx`); shared props interfaces named `I<Component>Props` (e.g. `IArticleCardProps`).
- React hooks: **exactly one hook per hook file** — never several hooks in one file, and never extra roles riding along: shared query keys go in `.constants.ts`, types in `.types.ts`, helpers in `.utils.ts`. A `use*.ts` file exports its hook (and nothing else) — internal module-level helpers it needs privately are fine.
- Hook names: `use` prefix + PascalCase — always `useHookName`, never a bare noun or verb (e.g. `useSavedArticles`, `useTheme`). The file name must match the hook name exactly: `useSavedArticles.ts` — never `use-saved-articles.hook.ts` or `useSavedArticles.hook.ts`.
- Interfaces: `I` prefix + PascalCase (e.g. `ITheme`, `ISavedArticle`).
- Type aliases & type unions: `T` prefix + PascalCase (e.g. `TTheme`, `TArticleCategory`).
- Variables, functions: `camelCase`.
- Compile-time constants only: `SCREAMING_SNAKE_CASE` (e.g. `WORDS_PER_MINUTE`); everything else camelCase.
- Legacy note: files predating these rules are grandfathered until touched — rename to the current scheme when significantly editing one:
  - `apps/web-extension/src/hooks/*.ts` (kebab-case, unsuffixed — e.g. `use-saved-articles.ts`) → the hook's own name (`useSavedArticles.ts`) — migration complete, no kebab hook files remain in `apps/web-extension`.
  - Existing kebab-case hook files `use-*.hook.ts` in `apps/dashboard` and `apps/internal_dashboard` (e.g. `use-me.hook.ts`) → the hook's own name (`useMe.ts`).
  - Old-suffix `.ts` files elsewhere — `.const.ts`, `<name>-store.ts`, and kebab-case base names — → `.constants.ts`, `.store.ts`, and camelCase base names respectively.

## Quick reference

| Kind                       | File name              | Example                                     |
| -------------------------- | ---------------------- | ------------------------------------------- |
| Rust module                | `snake_case.rs`        | `audio_metadata_extraction.rs`              |
| Rust crate                 | `kebab-case`           | `libryva-server`                            |
| Dart file / folder         | `snake_case`           | `audiobook_repository.dart`                 |
| Dart widget class          | `PascalCase`           | `ThemedText` in `themed_text.dart`          |
| Flutter test               | `snake_case_test.dart` | `audiobook_repository_test.dart`            |
| Astro component / layout   | `PascalCase.astro`     | `FeatureCard.astro`                         |
| Astro page / content slug  | `kebab-case`           | `pages/legal/privacy-policy.astro`          |
| Astro TS config / endpoint | `camelCase.ts`         | `site.ts`, `rss.xml.ts`                     |
| WXT extension module       | `camelCase`            | `browserExtract.ts`                         |
| TS React component         | `<name>.tsx` (kebab)   | `ArticleCard` in `article-card.tsx`         |
| TS React hook              | `useHookName.ts`       | `useSavedArticles` in `useSavedArticles.ts` |
| TS constants / query keys  | `<name>.constants.ts`  | `mfa.constants.ts` (`MFA_KEY`)              |
| TS utils                   | `<name>.utils.ts`      | `chatCrypto.utils.ts`                       |
| TS API module              | `<name>.api.ts`        | `savedArticles.api.ts`                      |
| TS shared types            | `<name>.types.ts`      | `article.types.ts`                          |
| TS Effect service          | `<name>.service.ts`    | `libraryStore.service.ts`                   |
| TS Zustand store           | `<name>.store.ts`      | `session.store.ts`                          |
| TS extension test          | `<name>.test.ts`       | `classify.test.ts`                          |
