# OpenSpecSight — Documento de diseño

**Fecha:** 2026-11-03
**Estado:** borrador para aprobación
**Qué es:** clon open-source y self-hosted de [SpecSight](https://specsight.app) — "observabilidad de producto": aprende tu producto desde el código del repositorio y mantiene una spec viva que se actualiza con cada release, en palabras que cualquiera (soporte, ventas, producto) entiende.

---

## 1. Intención y por qué

SpecSight cobra 150 €/mes y es cerrado. Queremos la misma idea como herramienta open-source que cualquiera despliegue contra sus propios repos de GitHub: conectas un repo, un LLM analiza el código y genera una **spec viva** (árbol de features con escenarios), y en cada sync el sistema registra **qué cambió, en palabras llanas**, con changelog, mapa del producto, diagramas de flujo, digests, notas de release y un buscador con IA que responde citando la spec.

El usuario final es "todos fuera de ingeniería"; el operador es el desarrollador que lo despliega.

## 2. Objetivos

- Conectar repos de **GitHub** (solo GitHub por ahora), vigilar una rama y disparar análisis/syncs.
- Generar y mantener la **spec viva**: árbol de features (máx. 2 niveles) con escenarios *Contexto + Acción → Resultado*, categorizados **Happy path (HP-n) / Edge case (ED-n) / Error (ER-n)**, con IDs estables.
- **Cambios por release**: tarjeta con título, categoría, autores, secciones New/Changed/Gone/Fixed y *Highlights*.
- **Product map**: grafo interactivo con 9 tipos de conexión entre features.
- **Flow diagrams** por feature (Start → pasos → decisiones → errores → End).
- **Ask**: preguntas en lenguaje natural respondidas **solo desde la spec**, con citas numeradas enlazadas a escenarios; conversaciones persistentes; se niega a responder si la spec no cubre el tema.
- **Digests** semanales/manuales por email (SMTP configurable) y **Release notes** redactadas por IA con editor de bloques y enlace público.
- **Annotations** en escenarios, **export** a Markdown, edición manual de la spec que **los syncs nunca sobrescriben**.
- Proyecto open-source (licencia MIT), configurable 100 % por `.env`, sin billing ni planes.

## 3. No objetivos (por ahora)

- GitLab u otros forges (el diseño deja la puerta abierta).
- Multi-organización, roles, billing, límites de plan, promo codes.
- MCP server y API keys (última fase, opcional).
- Export a PDF/Excel (solo Markdown al inicio).
- Primer análisis automático por webhook (el MVP usa "Sync now" manual; el webhook llega después).

## 4. Anti-objetivos (fracaso aunque funcione)

- Que un sync destruya ediciones manuales del usuario.
- Que Ask invente respuestas sin cita a la spec.
- Que el repo clonado no arranque con `pnpm install && pnpm dev` y un `.env` de ejemplo.
- Dependencias de pago o servicios cerrados obligatorios: todo proveedor (LLM, SMTP) va por `env`.

## 5. Restricciones

- **Stack decidido:** Nuxt 4 (monolito, enfoque A) — abajo el detalle.
- **Solo GitHub**, con PAT de grano fino que aporta quien despliega.
- Keys y credenciales **solo en `.env`** (el usuario aporta: token MiniMax coding plan, PAT de GitHub, credenciales Gmail SMTP).
- Comunicación con el usuario (chat) en español; **código, issues, README, UI y contenido generado: todo en inglés** (lenguaje universal para el crecimiento del proyecto open-source). i18n de la UI: fase futura.
- Todo lo "pesado" de LLM debe correr en background (no bloquear la UI).

## 6. Enfoques considerados

### A. Monolito Nuxt 4 — **ELEGIDO**
Una app Nuxt 4: UI (Nuxt UI v4) + API (Nitro `server/api`) + trabajos (Nitro `server/tasks` + cola en SQLite) + SQLite local. Un proceso, un `.output`, despliegue trivial. El análisis LLM corre en background dentro del mismo proceso, con cola y límites; suficiente para repos de hasta ~10k ficheros (los mismos límites que Specsight).

### B. Front + API + worker separados — descartado
Mejor para escalar análisis de repos enormes, pero 3 procesos y 2 despliegues para quien clona el repo: fricción injustificada en MVP open-source. Si un día hace falta, la cola ya está en SQLite y el worker se extrae sin cambiar el modelo de datos.

### Decisiones de detalle con alternativas
- **BD:** `better-sqlite3@13` + **Drizzle ORM** (tipos + migraciones). Alternativa descartada: `node:sqlite` nativo (estable en Node 24, pero Drizzle 0.45 no tiene driver para él y SQL a mano cuesta mantenerlo).
- **LLM:** Vercel **AI SDK** con proveedor configurable por env (`LLM_API_STYLE=anthropic|openai`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`). **Por defecto apunta al coding plan de MiniMax** (endpoint compatible con la API de Anthropic). Alternativa descartada: SDK de un solo proveedor.
- **RAG:** **FTS5 de SQLite** (viene compilado dentro; sin embeddings ni extensiones). Alternativa descartada: sqlite-vec + embeddings (más infra y otro modelo que pagar).
- **Grafos:** **Vue Flow** para product map y flow diagrams. Alternativas: Cytoscape+elkjs (más control, mucho más código) o Mermaid (estático, no interactivo).
- **Auth:** un solo usuario operador con contraseña en `env` (`AUTH_PASSWORD`) y sesión firmada (`SESSION_SECRET`). Multi-usuario/roles: fase futura.

### Resolución de la revisión del builder (llamadas del diseñador)

Una revisión independiente del diseño planteó 6 dudas; cinco se cierran así (decisión del diseñador, revisable):

1. **¿Cómo sabe un sync qué features afecta un diff?** El análisis inicial emite un mapa **feature ↔ rutas de ficheros** (tabla `feature_files`). El sync cruza las rutas del diff con ese mapa para seleccionar features afectadas; el propio LLM puede además marcar features extra si el diff lo sugiere. No se envía nunca "toda la spec + todo el diff".
2. **¿Qué significa un proyecto con varios repos?** Lo mismo que en SpecSight: varios repos se leen como **un solo producto** — un único árbol de features fusionado. Los releases pertenecen a un repo, pero Changes y Overview los muestran fusionados en orden cronológico.
3. **Semántica de "los syncs nunca tocan lo manual":** los escenarios con `source=manual` jamás se modifican; si el LLM propone un cambio sobre uno, se guarda como revisión `proposed` (no aplicada) visible como insignia "cambio sugerido" en el escenario, y el usuario la aplica o descarta. Sin pantallas de conflicto bloqueantes.
4. **¿Quién recibe los digests?** `DIGEST_RECIPIENTS` en `env` (lista separada por comas, global para el MVP); lista por proyecto en fase futura.
5. **¿Los syncs actualizan conexiones y flows?** Sí — pero solo de las features afectadas (vía el mapa de #1), en la misma pasada del LLM que los escenarios. Así el mapa y los flows no quedan viejos.

6. **Idioma del contenido generado** (features, escenarios, changes, release notes) — **pendiente: solo lo decide el usuario** (afecta prompts, FTS5 y la "voz" de las notas).

## 7. Cómo se construye

### 7.0 Arquitectura del código (mantenibilidad a largo plazo)
Monolito Nuxt 4, pero **por capas** (sin ciclos, dependencias hacia dentro):

```
app/                        # UI (auto-imports de Nuxt activos)
  components/               # solo presentación (Nuxt UI v4 + Vue Flow)
  composables/              # estado y llamadas (useProjects, useAsk…)
  pages/                    # rutas file-based
server/
  api/                      # endpoints HTTP delgados (validan con zod, delegan en servicios)
  services/                 # LÓGICA DE NEGOCIO: analysis, sync, ask, digest, releaseNotes, github, llm, mail
  db/                       # Drizzle: schema.ts, client, migrations, consultas (repositorios tipados)
  jobs/                     # cola sobre Nitro tasks
shared/                     # tipos y schemas zod compartidos cliente/servidor (contrato API)
```

- **Regla:** las páginas llaman a composables → API → servicios → repositorios Drizzle. La UI nunca toca la BD ni octokit directamente.
- **Auto-imports de Nuxt 4** para composables/utils/componentes (nada de imports manuales innecesarios); imports explícitos solo fuera de esos directorios.
- Guías activas durante la implementación: skills `nuxt`, `nuxt-ui`, `vue-best-practices` y `typescript-best-practices` + MCPs oficiales `nuxt` y `nuxt-ui` para consultar documentación y ejemplos de componentes.
- TypeScript strict en todo; `shared/` es la única fuente de tipos de dominio (Feature, Scenario, Release…).

### 7.1 Stack (versiones verificadas en npm el 2026-11-03)
- Nuxt `^4.6.4` (trae Vite 8.3.5 con Rolldown+Oxc — "lo nuevo para compilar rápido" ya incluido; Nitro/nitropack 2.13, h3 1.15)
- `@nuxt/ui` `^4.12` (Tailwind 4) — componentes con ayuda del MCP oficial `nuxt-ui`
- `better-sqlite3` `^13` + `drizzle-orm` `^0.45` + `drizzle-kit`
- `ai` (Vercel AI SDK, versión vigente al scaffold) + `@ai-sdk/anthropic` y `@ai-sdk/openai-compatible`
- `octokit`, `@vue-flow/core`, `zod` `^4`, `nodemailer`
- Tests: `@playwright/test` (e2e) + `vitest` (unit)
- pnpm · Node 24 LTS · TypeScript strict · licencia MIT

### 7.2 Configuración por entorno (`.env.example`)
```ini
# LLM (por defecto: coding plan de MiniMax, API compatible con Anthropic)
LLM_API_STYLE=anthropic            # anthropic | openai
LLM_BASE_URL=https://api.minimax.io/anthropic
LLM_API_KEY=
LLM_MODEL=                         # p. ej. MiniMax-M2.x (se fija al scaffold)
LLM_MOCK=false                     # true = respuestas grabadas para tests/desarrollo sin key

# GitHub
GITHUB_TOKEN=                      # PAT por defecto; cada proyecto puede tener el suyo
GITHUB_MAX_FILES=10000
GITHUB_MAX_TOTAL_BYTES=157286400   # 150 MB

# App
DATABASE_PATH=./data/app.db
AUTH_PASSWORD=                     # contraseña del único usuario
SESSION_SECRET=
PUBLIC_APP_URL=http://localhost:3000

# SMTP (digests por email; Gmail: smtp.gmail.com:587 + contraseña de aplicación)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=
DIGEST_RECIPIENTS=                 # digests: correos separados por comas
DIGEST_WEEKLY_ENABLED=false
```

### 7.3 Modelo de datos (Drizzle → SQLite)
- `projects` — nombre, descripción; `repositories` (1-N): owner/repo, rama, PAT (cifrado con SESSION_SECRET), último commit sincronizado.
- `analyses` — project, tipo (initial|sync), estado (queued|running|done|error), progreso, stats JSON, error.
- `features` — project, parent (máx. 2 niveles), nombre, descripción, orden, `source: ai|manual`.
- `scenarios` — feature, contexto, acción, resultado, categoría (happy|edge|error), código estable (HP-1…), orden, `source`.
- `releases` — project, sha, mensaje, fecha, título IA, categoría, highlight, "worked on" (autores), resumen.
- `scenario_revisions` — release, escenario, tipo de cambio (new|changed|gone|fixed), estado (`applied|proposed`), before/after JSON.
- `feature_files` — feature ↔ ruta(s) de fichero del repo (empleado por el sync para localizar features afectadas por un diff).
- `connections` — project, feature A → feature B, tipo (9 valores: leads_to, triggers, depends_on, shares_data, authenticates, notifies, configures, embeds_in, competes_with).
- `flows` — feature, grafo JSON (nodos tipo start|step|decision|error|end + aristas con etiqueta).
- `annotations` — escenario, cuerpo, autor, fecha.
- `digests` — project, rango fechas, título, bloques JSON, estado de email.
- `release_notes` — project, título, rango, voz, bloques JSON, slug público, publicado.
- `conversations` / `messages` — Ask: preguntas, respuestas con `citations` JSON (scenario_id, texto).
- `jobs` — cola genérica (payload, estado, intentos) para Nitro tasks.

### 7.4 Pipeline LLM
1. **Análisis inicial** (job): octokit `git/trees?recursive` de la rama → filtrado por extensiones y límites → lectura de blobs (por lotes) → **genera en pasos** con *structured output* (zod): (a) inventario de features (2 niveles), (b) escenarios por feature, (c) conexiones, (d) flow por feature. Todo se guarda con `source=ai`. Progreso visible en UI.
2. **Sync** (manual "Sync now"; webhook después): commits desde el último sha → `compare` parches diff → rutas del diff cruzadas con `feature_files` (más las que marque el LLM) → por cada feature afectada se envía su spec actual + su diff → el LLM devuelve escenarios new/changed/gone/fixed **nunca tocando `source=manual`** (sobre manuales solo deja revisiones `proposed`, ver §6) y refresca conexiones y flow de esas features → se crea `release` + `scenario_revisions` + tarjeta Changes.
3. **Ask:** consulta FTS5 sobre scenarios+features → top-k → prompt con escenarios numerados → respuesta con citas `[n]` → cada cita enlaza a `/spec/[feature]#[scenario]`. Sin cobertura → "la spec no lo cubre".
4. **Digest / Release notes:** agregación de cambios del rango (o selección manual) → LLM redacta bloques MD con la "voz" configurada → editor de bloques → publicar (nota) / enviar (digest por SMTP).

### 7.5 Pantallas (Nuxt UI v4)
- `/` — lista de proyectos con estado de análisis.
- `/projects/[id]` — **Overview**: barra Ask, releases día a día, highlights.
- `/projects/[id]/changes` (+ `/changes/[sha]`) — filtrar por fuente/feature, buscar; detalle con New/Changed/Gone/Fixed y enlace a spec.
- `/projects/[id]/spec` (+ `/spec/[featureId]`) — árbol de features con contador; detalle con pestañas **Scenarios** (filtros happy/edge/error, lista/tabla, annotations, edición manual) y **Flow diagram** (Vue Flow).
- `/projects/[id]/map` — product map (Vue Flow): pan/zoom/fit/fullscreen, hover en aristas muestra tipo(s) de conexión, búsqueda.
- `/projects/[id]/digests` (+ detalle) — semanales y manuales.
- `/projects/[id]/release-notes` (+ editor, + `/notes/[slug]` público).
- `/projects/[id]/ask` (+ conversación) — con barra global ⌘K.
- `/settings` — GitHub, LLM, SMTP, cuenta.
- Modo claro/oscuro, responsive, **UI en inglés** (i18n como fase futura).

### 7.6 Pruebas
- `vitest`: schemas zod, consultas Drizzle/FTS5, lógica de diff/sync con fixtures.
- `@playwright/test` (+ MCP Playwright para depurar a mano): flujo completo con `LLM_MOCK=true` y un repo fixture local servido por un stub de la API de GitHub — así el e2e no consume tokens.
- Se corrige cualquier error que Playwright destaque antes de dar por buena una fase.

### 7.7 Fases de entrega
0. **Scaffold**: repo git, Nuxt 4 + Nuxt UI + Drizzle + auth single-user + `.env.example` + CI básico.
1. **Proyectos y GitHub**: alta de proyecto/repo/rama/PAT, lectura de árbol y metadatos.
2. **Pipeline de análisis inicial** (con LLM_MOCK primero) + UI de progreso.
3. **Spec viva**: árbol, escenarios, categorías, edición manual protegida, annotations.
4. **Changes**: sync manual, revisions, tarjetas de release, Overview con timeline.
5. **Product map + flow diagrams** (Vue Flow) desde los datos del análisis.
6. **Ask**: FTS5, citas, conversaciones, ⌘K.
7. **Digests + SMTP** y **Release notes** (draft IA, editor, página pública).
8. **Extras**: export Markdown, webhook de GitHub, MCP server + API keys.

## 8. Queda al criterio del builder
- Nombres exactos de modelos MiniMax coding plan vigentes (fijar en scaffold y documentar en README).
- Biblioteca de sesiones (nuxt-auth-utils vs middleware propio) — cualquiera vale si usa `AUTH_PASSWORD`/`SESSION_SECRET`.
- Paginación/límites concretos de la UI, copy exacto de textos, diseño visual (respetar Nuxt UI v4 y modo oscuro).
- Estrategia de chunking exacta del prompt de análisis (límites de contexto del modelo elegido).
- Cómo cifrar el PAT por proyecto (AES-GCM con SESSION_SECRET es suficiente).

## 9. Decisiones del usuario (cerradas)
- **Idioma:** todo en inglés — contenido generado por el LLM (features, escenarios, changes, digests, release notes), UI y documentación del repo. Decidido el 2026-11-03 por el dueño del proyecto (alcance universal, open-source). Nuestra conversación sigue en español; los prompts al LLM piden explícitamente salida en inglés.
