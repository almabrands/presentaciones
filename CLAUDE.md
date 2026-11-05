# Presentaciones Almabrands — editor HTML → PDF

App para crear/editar presentaciones comerciales de Almabrands como HTML y exportarlas a PDF vectorial 16:9.

**Producción:** https://almabrands-presentaciones.vercel.app (Vercel + Supabase)
**Local:** `npm start` (o `node server.js`) → http://localhost:5177 (sin Supabase; archivos locales)

## Despliegue (estado al 2026-11-03)
- Repo: github.com/almabrands/presentaciones (cuenta GitHub `almabrands`)
- Vercel: proyecto `steps-proyectos/almabrands-presentaciones` (cuenta ealdunate@almabrands.com)
- Supabase: proyecto `datmhpgzdqhukidylkon` (cuenta ealdunate@almabrands.com)
- Variables Vercel configuradas: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `AI_PROVIDER=api`
- **Pendiente:** `ANTHROPIC_API_KEY` (activa el botón ✨ IA en producción)
- **Pendiente:** Google Auth (hoy la URL es pública sin login)
- Storage: bucket `media` público en Supabase; fotos se suben al guardar
- PDF: "Imprimir → Guardar como PDF" desde el navegador (vectorial, funciona en producción)

## Estructura
- `server.js` — servidor Node sin dependencias: estáticos + API (`/api/list`, `/api/new`, `/api/save`, `/api/stat`, `/api/rename`, `/api/delete`, `/api/pdf`). El PDF se genera con Chrome headless (`--print-to-pdf`) sobre `?print=1`.
- `core/alma.css` — sistema visual compartido (lienzo 1920×1080, tipografía Poppins/Caveat, componentes). **Toda la gráfica vive aquí.**
- `core/editor.js` + `core/editor.css` — editor en el navegador (solo UI; nunca se guarda en el HTML de la presentación).
- `core/assets/` — logos almabrands (color/blanco), `pincel.png` (borde rasgado), trazos (flecha, “Desafío”, escalera), logos Hush Puppies, fotos de ejemplo.
- `imagenes.js` — banco de imágenes `media/` (archivos con nombre = hash del contenido; el HTML los referencia como `../media/<hash>.jpg`) y detección/recorte de fotos dentro de PDF (pdftocairo/pdftoppm + sips).
- `media/` — fotos de todas las presentaciones y plantillas (compartido; una foto repetida se guarda una vez). No borrar archivos a mano: puede usarlos más de una presentación.
- `plantillas/` — réplicas de las 3 presentaciones de referencia: `metro.html` (rojo), `hushpuppies.html` (informe, rojo/morado), `bice.html` (morado).
- `presentaciones/` — presentaciones del usuario (una por archivo). `.historial/` guarda las últimas 25 versiones de cada una; `.papelera/` las eliminadas.
- `.env` (local, no se versiona) — proveedor de IA y cuentas (`CLAUDE_PROFILES`); plantilla en `.env.example`.

## Convenciones para editar un HTML de presentación (Claude Code)
- Cada slide: `<section class="slide" data-layout="…"><div class="canvas">…</div></section>`. El lienzo mide **1920×1080 px**; todos los hijos directos de `.canvas` son `position:absolute` y se ubican con `style="left/top/width"` en px.
- Colores siempre con variables: `--accent` (principal), `--accent2`, `--accent3`, `--mint`, `--ink`, `--gray`. Para cambiar el color de una slide: `style="--accent:var(--purple)"` en su `.canvas`. Fondos: `.bg-ac`, `.bg-ac2`, `.bg-ac3`.
- Tipografía: `.t-xl .t-lg .t-md .t-sm .t-xs` (títulos), `.kick`, `.lead`, `.p`, `.p-sm`, `.p-xs`, `.hand` (manuscrita Caveat), `.uh` (prefijo “_ ”), `.crumb` (miga superior). Listas: `.list .dash .chk .arr .num`.
- Imágenes: siempre como slot `<div class="foto" data-hint="…" style="…">`. Con imagen: agregar clase `lleno` y `background-image:url(...)`. Modificadores: `bw` (B/N), `contain`, `round`, `rad`. Las imágenes viven en `media/` y se referencian como `url(../media/<hash>.jpg)`; las fotos subidas en el editor llegan en base64 y el servidor las convierte en archivos de `media/` al guardar (`imagenes.externalize`).
- Borde rasgado: `<div class="pincel">` (blanco) o `.pincel.ac` (color); `.flip` lo invierte.
- Bloques repetibles (tarjetas, filas, columnas, filas de tabla): el contenedor lleva `class="rep"`; el editor permite duplicar/mover/eliminar sus hijos directos.
- Gráficos: el texto manda. Barras: `.bars > .bar > .lbl + .s(i + b)`; dona: `.donut > ul.legend > li(style="--c:…") > b`. Gantt: `table.gantt`, celdas `td.on` (y `.alt`).
- Marca: `img.logo` (esquina inferior derecha; usar `logo-almabrands-blanco.png` sobre fondos de color) o `.foot` (cliente | almabrands).
- No agregar atributos `contenteditable`, clases `ed-*` ni estilos del editor: los pone `editor.js` en tiempo de ejecución.
- Rutas de assets relativas: `../core/assets/…` (plantillas y presentaciones están al mismo nivel).
- Si el editor está abierto en el navegador, se recarga solo al detectar cambios en disco (si había cambios sin guardar, ofrece elegir).

## IA con Claude (Fase 2)
- Botón ✨ en cada slide (y "IA" en la barra): prompt → reescribir la slide o crear una nueva después; acepta datos pegados y adjuntos (imágenes, PDF y texto; arrastrar, pegar o botón; máx. 10 archivos / 25 MB). Las imágenes adjuntas pueden quedar dentro de la slide (`data:ADJ_n` → archivo en `media/`). De cada PDF adjunto se extraen sus fotos (`expandPdfImages`, máx. 16, posición exacta vía SVG de pdftocairo; la imagen original si no tiene máscara, si no un recorte del render) y se envían como imágenes adjuntas extra (`extraido: true`, no cuentan para los límites). Se deshace con ⌘Z.
- `ai.js` arma el prompt de sistema con la sección "Convenciones" de este archivo + `core/alma.css` + el `<style>` del tema, y devuelve solo el `<section>`. Las imágenes base64 se reemplazan por `data:IMG_n` antes de enviar y se restauran al volver.
- Proveedor por `.env` (ver `.env.example`):
  - `AI_PROVIDER=claude-code` (por defecto): usa la CLI de Claude Code con la cuenta del usuario. Requiere iniciar sesión una vez: `"<ruta CLI>" auth login` (la ruta exacta aparece en el diálogo de IA si falta la sesión). Solo uso local/personal.
  - Varias cuentas: `CLAUDE_PROFILES=default,~/.claude-gmail` en `.env` (orden de uso). `default` es la sesión normal de la CLI; cada carpeta es otra cuenta vía `CLAUDE_CONFIG_DIR` (login: `CLAUDE_CONFIG_DIR=~/.claude-gmail "<ruta CLI>" auth login`). Si una cuenta responde que llegó a su límite, se marca hasta la hora de renovación ("resets 4:10pm") y se usa la siguiente. `GET /api/ai/status` devuelve `cuentas` y `loginCmd`.
  - `AI_PROVIDER=api` + `ANTHROPIC_API_KEY`: API de Anthropic con `@anthropic-ai/sdk` (modelo `AI_MODEL`, por defecto `claude-opus-5-5`; esfuerzo `AI_EFFORT`, por defecto `medium`; con `fallbacks: "default"` ante rechazos por política). Es el modo para producción.
- Endpoints: `GET /api/ai/status`, `POST /api/ai {path, slideHtml, prompt, mode: "replace"|"new", data, files: [{name, type, data(base64)}], web}`.
- Búsqueda en internet (`web: true`; casilla 🌐 en el diálogo, se marca sola si el prompt habla de internet/datos reales; también en Crear presentación): CLI con `--tools WebSearch,WebFetch`, API con `web_search_20260209` + `web_fetch_20260209` (y reenvío en `pause_turn`). Las reglas (`WEB_RULES`) van en el mensaje. Claude pone las fotos como `<div class="foto lleno" data-web="URL">` y `resolveWebImages` las descarga a `media/` (solo hosts públicos; si la URL es una página usa su og:image; si falla, el slot queda vacío con la URL en `data-hint`). En crear, solo el plan investiga: devuelve `investigacion` (se pasa a cada slide) y `fotos_web` por slide (se descargan antes de adaptar).
- En modo claude-code se usa `--input-format stream-json` para enviar imágenes y PDF; cada llamada corre en una carpeta temporal (no carga este CLAUDE.md) y sin sesión persistente.

## Ficha de cada presentación (memoria) y buscador
- Cada HTML lleva en su `<head>` un `<script type="application/json" id="ficha">` con: `cliente, tipo, estado, fecha, responsable, valor, plantilla` (texto), `rubros, segmentos, servicios, estudios, productos, etiquetas` (listas) y `fondo` (de qué trata) / `forma` (cómo está construida). Lógica en `ficha.js` (`readFicha`, `writeFicha`, `slidesText`, `OPCIONES` con los valores de tipo/estado/servicios).
- **Al editar el contenido de una presentación con Claude Code, actualiza también su ficha** si cambia el fondo o la forma. Mantén el JSON válido.
- Una presentación nueva desde plantilla hereda solo la `forma`; un duplicado copia la ficha completa (estado → Borrador).
- La ficha se usa en: filtros y búsqueda del Home, contexto del prompt al generar slides (`buildSystem`), y el buscador con IA.
- Endpoints: `POST /api/ficha {path, ficha}` (guarda), `POST /api/ficha/ai {path, ficha}` (propone completándola desde el contenido; no guarda), `POST /api/buscar {query}` (ranking con `calce` 0-100, `razon`, `ajustes`, `slides_utiles`; envía a la IA fichas + títulos de slides de todas las presentaciones y plantillas).

## Crear presentación completa con IA
- Home → pestaña "Crear presentación con IA": brief + adjuntos (imágenes, PDF, texto) + datos + estilo base (opcional) + largo (opcional).
- Imágenes en crear: la biblioteca indica cuántas fotos tiene cada slide; el plan asigna `imagenes: [n]` (adjuntos y fotos extraídas de PDF) a cada slide y solo esas se envían al adaptarla.
- `crear.js` + `core/crear-ia.js` (el navegador orquesta pasos cortos; igual en local y en Vercel): (1) **planifica** (`POST /api/crear/plan {brief, titulo?, base, largo, data, files, web}`) con un índice de todas las slides visibles de plantillas y presentaciones (`sN`, layout, título, extracto): cada slide del plan tiene un `origen` (`src: {path, n}`) que es su molde gráfico y `accion` reusar|adaptar; con web, `POST /api/crear/fotos {urls}` descarga las `fotos_web` a `media/`; (2) **adapta** cada slide (`POST /api/crear/slide`, 3 en paralelo desde el navegador) usando el origen como molde y el brief + estructura completa como contexto; (3) **arma** (`POST /api/crear/guardar {titulo, base, ficha, slides:[{html}|{src}]}`) sobre el `<head>`/tema de la presentación base, con la ficha propuesta (estado Borrador), vía `storage`. Si una slide falla, queda la de origen para editar a mano. No cerrar la pestaña mientras trabaja.
- Adjuntos (crear y ✨): las imágenes se suben antes a `/api/media` y viajan como `{name, type, media: "../media/…"}` (`ai.hydrateFiles` las carga para Claude; `restoreAttachments` reutiliza esa URL). De cada PDF el navegador saca sus fotos con pdf.js (`AlmaImport.pdfAttachment`, máx. 16, `extraido: true`); el PDF va embebido si los PDF suman ≤ 2,5 MB (base64), si no como texto (`{type: "text/plain", text}`). En el servidor `expandPdfImages` (poppler) solo corre si no llegaron fotos extraídas.
- Los estilos de componentes de todas las plantillas viven en `core/alma.css` (los `<style>` de cada plantilla solo definen colores del tema), para que cualquier slide funcione dentro de cualquier presentación. Mantén esa regla al crear plantillas nuevas.

## Home con sidebar
Vistas por hash: `#presentaciones` (buscar/crear con IA + lista y filtros), `#plantillas` (importar + lista), `#diseno` (Diseño & estilo).

## Plantillas desde archivo (`core/pdf-import.js` + `plantilla.js`)
- Funciona igual en local y en Vercel: el **navegador** hace el trabajo pesado con pdf.js 4.10.38 (cdnjs) y orquesta pasos cortos (cada request < 4,5 MB; sin trabajos en memoria ni disco):
  1. Miniaturas + texto por página → `POST /api/plantillas/analizar {pages:[{n,thumb,text}], nombre, notas}` → `{nombre, tema, estilo, ficha, paginas}` (≤ 24 páginas representativas).
  2. Posición exacta de cada imagen de las páginas elegidas desde la lista de operaciones de pdf.js (`detectBoxes`: CTM, clips, form XObjects; sin logos/pies repetidos).
  3. Por página (3 en paralelo): `POST /api/plantillas/replicar {a, page, idx, total, image(1600×900), text, boxes}` → `{html}` con slots `data-img="N"` / `data-crop="x,y,w,h"`. El navegador recorta cada foto (la imagen original del PDF sin textos encima si no está rotada ni con máscara; si no, el render a 2×), la sube con `POST /api/media {type, data}` → `{url: "../media/<hash>.ext"}` y reemplaza el slot. Las fotos originales grandes que Claude no usó se agregan en su posición.
  4. `POST /api/plantillas/guardar {a, slides}` → `{path}` (estado "Plantilla", vía `storage`).
- Imágenes de slides (PNG/JPG): mismo flujo, recortes desde la imagen. HTML del sistema: el navegador sube sus imágenes base64 a `/api/media` y llama `POST /api/plantillas/html {html, nombre}` (completa la ficha).
- `POST /api/plantillas/desde {path, titulo}` convierte una presentación en plantilla. Eliminar una plantilla la mueve a `plantillas/.papelera`.

## Diseño & estilo (`estilo.js`)
- Colores de marca (`--red, --purple, --teal, --mint, --lila, --ink, --gray`) y fuente (`@import` marcado con `@fuente` + `--font`) viven en `core/alma.css` → afectan a todas las presentaciones.
- Tema por plantilla: `:root{--accent;--accent2;--accent3}` del `<style>` de cada plantilla (puede apuntar a `var(--red)` etc.). Las presentaciones ya creadas conservan su propio tema.
- Logos: `core/assets/logo-almabrands.png` / `-blanco.png` (PNG).
- Guía de marca para la IA: `core/marca.md`, se inyecta en todos los prompts (slides, crear, importar, fichas).
- `GET /api/estilo`, `POST /api/estilo {colores?, font?, guia?, temas?, logo?}`. Cada cambio respalda el archivo en `core/.historial/` o `core/assets/.historial/`.


## PENDIENTE — Despliegue en GitHub + Vercel + Supabase + Google Auth (plan acordado, NO iniciado)
Estado al 2026-11-01: solo plan. La app hoy está pensada para correr local (Mac).

### Qué hay que cambiar para Vercel
| Hoy (local) | Problema en Vercel | Solución propuesta |
|---|---|---|
| Presentaciones, plantillas, estilos y guía como archivos en disco | Vercel no persiste escrituras | Supabase Postgres: tablas de presentaciones/plantillas (HTML + ficha jsonb), historial de versiones y configuración (guía, colores, fuente) |
| Fotos como archivos en `media/` (`../media/<hash>.jpg`); el editor sube base64 y el servidor las externaliza al guardar | Sin disco persistente y límite de ~4,5 MB por request | Supabase Storage con el mismo nombre por hash: el navegador sube directo y el HTML guarda la URL; migrar `media/` tal cual |
| IA vía CLI de Claude Code (cuenta personal, varias cuentas con `CLAUDE_PROFILES`) | No existe en Vercel | `AI_PROVIDER=api` + `ANTHROPIC_API_KEY` (ya implementado en `ai.js`, incluida la búsqueda web con `web_search`/`web_fetch`) |
| Descarga de fotos web (`fetchImage`) | Funciona, pero escribe en `media/` | Subir a Supabase Storage en vez de disco |
| Trabajos largos en memoria (`crear.js`, `plantilla.js`) | Funciones con tiempo máximo y sin estado | **Hecho**: el navegador orquesta pasos cortos (1 llamada de plan + 1 por slide) |
| Importar PDF y extraer fotos de PDF adjuntos con poppler (`pdftoppm`, `pdftocairo`) y `sips` (macOS) | No disponibles | **Hecho** con pdf.js en el navegador: importar plantilla, fotos de PDF adjuntos en ✨ IA y Crear presentación |
| Exportar PDF con Chrome headless | Chrome no incluido | A) `puppeteer-core` + `@sparticuz/chromium` (verificar límites del plan); B) solo "Imprimir → Guardar como PDF" (ya funciona, vectorial) |
| Diseño & estilo reescribe `core/alma.css` y `core/marca.md` | Sin escritura en disco | Guardar en BD y servir un `tema.css` dinámico |
| Recarga en vivo al editar con Claude Code | No aplica en producción | Mantener modo local para trabajar con Claude Code |

### Google Auth
- Supabase Auth con proveedor Google; acceso solo a dominios/correos permitidos (ej. `@almabrands.com` + correo Steps).
- RLS: solo usuarios autenticados leen/escriben; a futuro roles (editor/lector) y registro de quién editó.
- Configurar credenciales OAuth en Google Cloud Console + Supabase.

### Fases
1. Repo propio (hoy la carpeta está dentro del repo git del home) y subir a GitHub.
2. Capa de almacenamiento con dos modos (archivos locales / Supabase) + script de migración de plantillas y presentaciones.
3. Login con Google y permisos.
4. Adaptar a Vercel: rutas de `server.js` como funciones (`/api/*`), orquestación por pasos en el navegador, pdf.js, opción de PDF.
5. Desplegar: variables de entorno (`ANTHROPIC_API_KEY`, Supabase), dominio y prueba completa.
Recomendación: no migrar a Next.js; el frontend actual (HTML + JS) sirve en Vercel y solo se convierte el servidor en funciones.

### Decisiones pendientes del usuario
- Cuentas de GitHub/Vercel (Almabrands, Steps o personal) y email de commit (Vercel Hobby bloquea el deploy si el autor no coincide).
- Plan de Vercel: Hobby es solo uso no comercial → para cliente corresponde Pro.
- Dominios/correos con acceso.
- PDF: exportación en servidor (A) o solo imprimir desde el navegador (B).
- Mantener modo local para trabajar con Claude Code (recomendado: sí).
