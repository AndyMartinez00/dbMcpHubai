# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Qué es

Servidor MCP que expone varias bases de datos (PostgreSQL, MySQL, MariaDB, SQL Server, Oracle, SQLite) a Claude Code. Todas las conexiones se definen en `.env`. No hay build, tests ni linter: el único código propio es `scripts/db-mcp.mjs`; el servidor MCP real es DBHub (`@bytebase/dbhub`, versión fija en `package.json`). La documentación para personas está en `README.md`.

## Comandos

- `npm install`: instala DBHub en `node_modules/` (el lanzador lo ejecuta desde ahí, no usa `npx`).
- `npm run list`: valida el `.env` y lista las conexiones sin conectarse ni mostrar contraseñas.
- `DB_MCP_ENV_FILE=<ruta> node scripts/db-mcp.mjs --list`: prueba la lectura con otro archivo `.env` (para pruebas: nunca modificar el `.env` real).
- `node scripts/db-mcp.mjs [NOMBRE ...]`: arranca el servidor con todas las conexiones, o solo con las indicadas.
- Probar el servidor MCP de punta a punta: lanzar `scripts/db-mcp.mjs` como proceso hijo y enviarle por stdin JSON-RPC línea a línea (`initialize`, `notifications/initialized`, `tools/list`, `tools/call`).

## Arquitectura

```
.mcp.json → node scripts/db-mcp.mjs → process.loadEnvFile(.env)
         → descubre conexiones por las claves CONN_<NOMBRE>_TYPE
         → genera un dbhub.toml temporal en os.tmpdir() ([[sources]] + [[tools]] por conexión)
         → spawn(node, node_modules/@bytebase/dbhub/dist/index.js --transport stdio --config <tmp>)
         → borra el TOML temporal al terminar
```

Puntos no obvios:

- **stdout es el canal del protocolo MCP.** En el lanzador, todo mensaje debe ir a `stderr` (`console.error`); un `console.log` rompe el protocolo. La única excepción es `--list`, que termina antes de arrancar DBHub.
- **Contraseñas fuera de disco.** El TOML solo contiene `password = "${CONN_<NOMBRE>_PASSWORD}"`; DBHub resuelve la referencia desde el entorno heredado del proceso padre. No escribir secretos en el TOML.
- **El modo de solo lectura es por herramienta, no por fuente.** DBHub lo define en `[[tools]]` (`execute_sql` con `readonly`/`max_rows`). Si se agrega un `[[tools]]` para una fuente, hay que declarar también `search_objects`, o no se expone.
- **`lazy = true` en cada fuente:** DBHub no conecta hasta el primer uso, así que una base inaccesible (por ejemplo, sin VPN) no impide arrancar las demás. El error aparece al consultar (`SOURCE_UNREACHABLE`).
- **Nombres de herramientas:** con una sola conexión, DBHub las llama `execute_sql` y `search_objects`; con varias, les agrega el id de la conexión en minúsculas (`execute_sql_<nombre>`).
- **Lectura del `.env` (`process.loadEnvFile`, Node ≥ 20.12):** si una variable ya existe en el entorno del sistema, gana sobre el `.env`; si una clave se repite, gana la última; un valor sin comillas se corta en `#`.
- **`READONLY` vale `true` por defecto.** Es un filtro de DBHub sobre el texto SQL (permite `SELECT`, `WITH`, `EXPLAIN` y `SHOW`), no un permiso de la base.

## Formato de conexiones

`CONN_<NOMBRE>_<CAMPO>`. Campos: `TYPE` (obligatorio y el que crea la conexión), `HOST`, `PORT`, `DATABASE`, `USER`, `PASSWORD`, `READONLY`, `MAX_ROWS`, `DESCRIPTION`, `SSLMODE` (Postgres), `INSTANCE` (SQL Server). El id de la conexión es `<NOMBRE>` en minúsculas. Al agregar un campo nuevo hay que actualizar a la vez `scripts/db-mcp.mjs` (validación y TOML), `.env.example` y la tabla de campos del `README.md`.

## Repositorio público

El repositorio se publica en GitHub. Los archivos versionados (`README.md`, `.env.example`, este archivo y el código) usan solo datos ficticios (dominios `*.example.internal`, bases como `ventas` o `tienda`); los nombres reales viven únicamente en `.env`, que está en `.gitignore`.

## Reglas al trabajar en este repositorio

- Para inspeccionar el `.env`, enmascara siempre los valores (por ejemplo `sed -E 's/=.*/=****/' .env`); nunca muestres contraseñas, hosts ni usuarios reales en la salida.
- Antes de consultar una base, identifica el entorno (QA o PR); si la petición es ambigua, pregunta.
- No propongas escrituras en PR ni cambiar `READONLY` de una conexión de PR.
- Los identificadores con mayúsculas o palabras reservadas van entre comillas dobles (`esquema."Tabla"`).
- No muestres datos personales completos (correos, documentos, teléfonos) salvo que se pidan explícitamente.
- Antes de un commit, confirma que `.env` y `CLAUDE.local.md` no aparecen en `git status`.
