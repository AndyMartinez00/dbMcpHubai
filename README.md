# dbMcp: servidor MCP para múltiples bases de datos

Permite que **Claude Code** consulte varias bases de datos (QA, PR, etc.) y distintos motores (**PostgreSQL, MySQL, MariaDB, SQL Server, Oracle y SQLite**) desde un único servidor MCP. Todas las conexiones se definen en un archivo `.env`.

> **En una frase:** Claude no se conecta por sí mismo a una base de datos; necesita un programa intermediario (un *servidor MCP*) que le ofrezca herramientas como "ejecutar este SQL en la base X". Este proyecto es ese servidor.

---

## Índice

1. [Inicio rápido](#1-inicio-rápido)
2. [Qué es MCP](#2-qué-es-mcp)
3. [Cómo funciona este proyecto](#3-cómo-funciona-este-proyecto)
4. [Archivos del proyecto](#4-archivos-del-proyecto)
5. [Configurar conexiones (`.env`)](#5-configurar-conexiones-env)
6. [Uso diario](#6-uso-diario)
7. [Tareas comunes](#7-tareas-comunes)
8. [Seguridad](#8-seguridad)
9. [Solución de problemas](#9-solución-de-problemas)

---

## 1. Inicio rápido

**Requisitos**

- Node.js **20.12 o superior**: `node --version`
- Claude Code (extensión de VS Code o CLI)
- **VPN conectada** si las bases están en la red interna

**Instalación**

```bash
# 1. Clonar e instalar dependencias
git clone <url-del-repo> dbMcp
cd dbMcp
npm install

# 2. Crear tu .env a partir de la plantilla
cp .env.example .env        # PowerShell: Copy-Item .env.example .env

# 3. Completar el .env con tus conexiones y credenciales (ver sección 5)

# 4. Verificar que las conexiones se leen bien
npm run list
```

**Activar en Claude Code**

1. Abre la carpeta `dbMcp` en VS Code (o ejecuta `claude` dentro de ella).
2. Escribe `/mcp` y **aprueba** el servidor `databases`. Solo se aprueba la primera vez.
3. Pregunta, por ejemplo: *"En QA, ¿cuántos esquemas tiene la base ventas?"*

---

## 2. Qué es MCP

**MCP (Model Context Protocol)** es un estándar para que un asistente como Claude use herramientas externas.

- Claude Code **inicia** el servidor MCP como un programa local.
- Se comunican por **stdin/stdout**, la entrada y salida estándar del programa, con mensajes JSON.
- El servidor anuncia sus **herramientas**, por ejemplo `execute_sql_ventas_pr`.
- Cuando haces una pregunta, Claude elige la herramienta, el servidor ejecuta la consulta y devuelve el resultado.

Tú no escribes mensajes MCP: le hablas a Claude en lenguaje natural.

---

## 3. Cómo funciona este proyecto

```
 Usuario: "¿cuántos esquemas tiene ventas en QA?"
  │
  ▼
 Claude Code
  │ 1. lee .mcp.json → servidor "databases": node scripts/db-mcp.mjs
  ▼
 scripts/db-mcp.mjs  (lanzador)
  │ 2. lee .env → encuentra los bloques CONN_<NOMBRE>_*
  │ 3. valida que no falten datos
  │ 4. genera una configuración temporal para DBHub (sin contraseñas, solo referencias)
  ▼
 DBHub  (node_modules/@bytebase/dbhub, el servidor MCP real)
  │ 5. crea las herramientas execute_sql_<nombre> y search_objects_<nombre>
  │ 6. se conecta a cada base la primera vez que se usa (lazy)
  ▼
 Base PR      Base QA      Base MySQL      Base SQL Server ...
```

**¿Por qué un lanzador y no DBHub directamente?** DBHub no lee un `.env` con varias conexiones. El lanzador traduce el `.env` al formato que DBHub entiende. Así, **para agregar una base solo se edita el `.env`**.

---

## 4. Archivos del proyecto

| Archivo | Para qué sirve | ¿Se sube a Git? |
|---|---|---|
| [`.mcp.json`](.mcp.json) | Le dice a Claude Code que existe el servidor `databases` y cómo arrancarlo. No tiene secretos. | ✅ Sí |
| [`.env`](.env.example) | Tus conexiones y contraseñas. | ❌ **Nunca** |
| [`.env.example`](.env.example) | Plantilla documentada con valores de ejemplo. | ✅ Sí |
| [`scripts/db-mcp.mjs`](scripts/db-mcp.mjs) | Lanzador: lee el `.env`, valida, genera la configuración y arranca DBHub. | ✅ Sí |
| [`package.json`](package.json) | Dependencia de DBHub, con la **versión fija**, y los comandos `npm`. | ✅ Sí |
| `node_modules/` | Librerías descargadas por `npm install`. | ❌ No |
| [`.gitignore`](.gitignore) | Excluye `.env` y `node_modules/`. | ✅ Sí |

### `.mcp.json`

```json
{
  "mcpServers": {
    "databases": {
      "command": "node",
      "args": ["scripts/db-mcp.mjs"]
    }
  }
}
```

`databases` es el nombre del servidor; las herramientas aparecen como `mcp__databases__...`. Casi nunca hace falta modificarlo.

### `scripts/db-mcp.mjs`

En orden, el lanzador:

1. Carga el `.env` con `process.loadEnvFile`, que viene incluido en Node 20.12 o superior.
2. Busca todas las variables `CONN_*_TYPE`; cada una define una conexión.
3. Valida cada conexión: motor soportado, y que no falten `HOST`, `DATABASE` ni `USER`. Si algo falla, muestra un mensaje claro y se detiene.
4. Genera un TOML temporal para DBHub. La contraseña aparece como `${CONN_<NOMBRE>_PASSWORD}` y DBHub la resuelve desde la memoria del proceso, **así que nunca se escribe en disco**.
5. Arranca DBHub y, al terminar, borra el archivo temporal.

```bash
node scripts/db-mcp.mjs                 # todas las conexiones (lo que usa Claude Code)
node scripts/db-mcp.mjs VENTAS_QA       # solo las conexiones indicadas
node scripts/db-mcp.mjs --list          # lista las conexiones sin conectarse ni mostrar contraseñas
```

> stdout es el canal del protocolo MCP: el lanzador escribe sus mensajes en stderr.

### `package.json`

```jsonc
"type": "module",                         // el código usa import/export
"engines": { "node": ">=20.12" },         // necesario para process.loadEnvFile
"scripts": {
  "start": "node scripts/db-mcp.mjs",     // npm start
  "list":  "node scripts/db-mcp.mjs --list" // npm run list
},
"dependencies": { "@bytebase/dbhub": "1.5.1" }  // versión fija a propósito
```

La versión fija evita que una actualización de DBHub cambie el comportamiento sin que nadie lo note. Para actualizarlo, cambia la versión, ejecuta `npm install` y prueba.

---

## 5. Configurar conexiones (`.env`)

Cada conexión es un bloque de variables con el prefijo `CONN_<NOMBRE>_`:

```ini
CONN_VENTAS_QA_TYPE=postgres
CONN_VENTAS_QA_HOST=pg-qa.example.internal
CONN_VENTAS_QA_PORT=5432
CONN_VENTAS_QA_DATABASE=ventas
CONN_VENTAS_QA_USER=app_lectura
CONN_VENTAS_QA_PASSWORD='<tu-contraseña>'
CONN_VENTAS_QA_READONLY=true
CONN_VENTAS_QA_DESCRIPTION="PostgreSQL ventas - QA"
```

### Reglas

- **`<NOMBRE>`** va en MAYÚSCULAS, con números y `_`. Se recomienda `<SISTEMA>_<QA|PR>`. En la herramienta aparece en minúsculas: `execute_sql_ventas_qa`.
- **La línea `_TYPE` es la que crea la conexión.** Sin ella, el bloque se ignora.
- **La contraseña va sin codificar.** Usa comillas simples si contiene `#`, espacios o `$`.
- El formato es `CLAVE=valor`, una por línea, y `#` sirve para comentarios.

### Campos

| Campo | Obligatorio | Descripción |
|---|---|---|
| `TYPE` | ✅ | `postgres`, `mysql`, `mariadb`, `sqlserver`, `oracle` o `sqlite` |
| `HOST` | ✅ (salvo sqlite) | Servidor |
| `PORT` | — | Por defecto: 5432 (postgres), 3306 (mysql/mariadb), 1433 (sqlserver), 1521 (oracle) |
| `DATABASE` | ✅ | Nombre de la base. En sqlite, la ruta del archivo. |
| `USER` | ✅ (salvo sqlite) | Usuario |
| `PASSWORD` | — | Contraseña |
| `READONLY` | — | `true` (por defecto) o `false`. **En PR, siempre `true`.** |
| `MAX_ROWS` | — | Máximo de filas por consulta. Por defecto 1000. |
| `DESCRIPTION` | — | Texto que Claude ve para saber qué es cada base. Recomendado. |
| `SSLMODE` | — | Solo PostgreSQL: `disable`, `require`, `verify-ca` o `verify-full` |
| `INSTANCE` | — | Solo SQL Server: instancia con nombre, por ejemplo `SQLEXPRESS` |

> El `.env` se lee **solo al arrancar el servidor**. Después de cualquier cambio, reconecta con `/mcp` → `databases` → **Reconnect**, o reinicia VS Code.

### Cómo funciona el archivo `.env`

**Ciclo de vida**

- Es **personal y local**: cada persona crea el suyo a partir de `.env.example` y nunca se sube a Git (`.gitignore` lo excluye).
- Lo lee **solo** `scripts/db-mcp.mjs` al arrancar el servidor MCP. Claude Code no lo lee directamente.
- Los cambios **no se aplican solos**: hay que reconectar con `/mcp` → `databases` → **Reconnect**.
- Las contraseñas no salen del `.env`: el lanzador las pasa a DBHub en memoria y nunca las escribe en otro archivo.

**Reglas de lectura (comprobadas)**

| Situación | Qué pasa | Cómo evitar problemas |
|---|---|---|
| La misma clave aparece dos veces | **Gana la última**, sin aviso | Usa un `<NOMBRE>` único por conexión |
| La variable también existe en Windows (variables de entorno del sistema) | **Gana la de Windows** y el valor del `.env` se ignora | No definas variables `CONN_*` en el sistema |
| Un valor contiene `#` y no tiene comillas | Se **corta** en el `#` (`abc#def` → `abc`) | Pon las contraseñas entre comillas simples: `'abc#def'` |
| Una línea comentada con `#` | Se ignora | Útil para desactivar una conexión temporalmente |

**Compartir credenciales con el equipo**

- Nunca por chat, correo, tickets ni commits.
- Usa el gestor de contraseñas del equipo, o pídeselas directamente al DBA.
- Lo ideal es que cada persona tenga **su propio usuario de base de datos**, para que los accesos se puedan rastrear.

**Si el `.env` se sube por error a Git**

1. **Cambia de inmediato** las contraseñas afectadas. Borrar el archivo no basta: queda en el historial y quien haya clonado el repositorio ya lo tiene.
2. Quita el archivo del índice: `git rm --cached .env` y luego haz un commit.
3. Limpia el historial (`git filter-repo` o BFG) y avisa al equipo.

---

## 6. Uso diario

Habla con Claude normalmente y **di siempre el entorno**:

- *"En QA, ¿qué tablas tiene el esquema `inventario`?"*
- *"Compara cuántos registros tiene la tabla X en PR y en QA."*
- *"Busca en PR las columnas cuyo nombre contenga `rut`."*

Cada conexión expone dos herramientas:

| Herramienta | Uso |
|---|---|
| `execute_sql_<nombre>` | Ejecuta SQL. |
| `search_objects_<nombre>` | Explora esquemas, tablas, columnas, índices y procedimientos sin escribir SQL. |

Si solo hay una conexión definida, las herramientas se llaman simplemente `execute_sql` y `search_objects`.

---

## 7. Tareas comunes

### Agregar una conexión, paso a paso

**1. Elige un nombre único** con el formato `<SISTEMA>_<QA|PR>`, por ejemplo `ERP_PR`.
Revisa con `npm run list` que no exista ya: si se repite, la nueva conexión reemplaza a la anterior sin avisar.

**2. Agrega el bloque al final de tu `.env`**, por ejemplo SQL Server de PR:

```ini
# --- ERP (SQL Server) - PR ------------------------------------------
CONN_ERP_PR_TYPE=sqlserver
CONN_ERP_PR_HOST=sqlserver-pr.example.internal
CONN_ERP_PR_DATABASE=ERP
CONN_ERP_PR_USER=usuario_lectura
CONN_ERP_PR_PASSWORD='...'
CONN_ERP_PR_INSTANCE=SQLEXPRESS
CONN_ERP_PR_READONLY=true
CONN_ERP_PR_DESCRIPTION="SQL Server ERP - PRODUCCIÓN"
```

**3. Verifica que se lea bien:**

```bash
npm run list
# ERP_PR    sqlserver  solo-lectura  usuario_lectura@sqlserver-pr.example.internal:1433/ERP
```

Si falta un campo obligatorio, el mensaje lo indica (por ejemplo `ERP_PR: falta CONN_ERP_PR_HOST`).

**4. Reconecta el servidor:** `/mcp` → `databases` → **Reconnect**.

**5. Comprueba en Claude** que aparecen las herramientas nuevas (`execute_sql_erp_pr` y `search_objects_erp_pr`) y prueba con: *"En ERP PR, ejecuta SELECT 1"*.

**6. Si la conexión es nueva para el equipo**, agrega también un ejemplo **con datos ficticios** a `.env.example`, nunca con los datos reales.

**Checklist de seguridad para conexiones de PR**

- [ ] `READONLY=true`
- [ ] Usuario de base de datos de solo lectura, nunca un administrador
- [ ] `DESCRIPTION` deja claro que es PRODUCCIÓN
- [ ] La contraseña va entre comillas simples

### Cambiar una contraseña

Edita la línea `_PASSWORD` y reconecta con `/mcp`.

### Permitir escritura (solo QA)

Pon `CONN_<NOMBRE>_READONLY=false` y reconecta con `/mcp`.

### Quitar una conexión

Borra su bloque o comenta su línea `_TYPE` con `#`, y reconecta con `/mcp`.

### Probar el servidor fuera de Claude Code

```bash
npm run list    # valida el .env sin conectarse
npm start       # arranca el servidor (queda esperando mensajes MCP; Ctrl+C para salir)
```

---

## 8. Seguridad

| Protección | Qué hace | Límite |
|---|---|---|
| `READONLY=true` (por defecto) | DBHub solo permite `SELECT`, `WITH`, `EXPLAIN` y `SHOW`. Cualquier otra sentencia se rechaza con `READONLY_VIOLATION`. | Es un filtro de la herramienta, no un permiso de la base. |
| `MAX_ROWS` | Limita las filas devueltas por consulta. | — |
| `.gitignore` | Evita subir el `.env` al repositorio. | No protege copias fuera del repositorio. |
| Contraseñas fuera del TOML | La configuración temporal solo contiene referencias `${VAR}`. | El `.env` sigue en texto plano en tu equipo. |

**Buenas prácticas**

- Para **PR**, usa un **usuario de base de datos de solo lectura**, nunca un superusuario o administrador. Así, aunque fallara el filtro de DBHub, la base impediría escribir.
- Nunca pegues credenciales en `.mcp.json`, en el código ni en el chat.
- Si una credencial se expuso (por ejemplo, se subió a Git), **cámbiala**.
- Indica siempre el entorno al hacer una pregunta, para no consultar PR por error.

---

## 9. Solución de problemas

| Síntoma | Causa probable | Solución |
|---|---|---|
| `/mcp` muestra *Pending approval* | Es la primera vez que se usa este `.mcp.json`. | Aprobar `databases` en `/mcp`. |
| `/mcp` muestra *Failed to connect* | Hay un error en el `.env` o falta `npm install`. | Ejecutar `npm run list`: el mensaje indica qué falta. |
| `DBHub no está instalado` | No existe `node_modules/`. | `npm install` |
| `No existe ...\.env` | No se creó el `.env`. | Copiar `.env.example` a `.env`. |
| `Conexiones no definidas en .env: X` | El nombre no coincide con ningún `CONN_X_TYPE`. | Revisar mayúsculas y guiones bajos. |
| `TYPE "..." no soportado` | Motor mal escrito. | Usar `postgres`, `mysql`, `mariadb`, `sqlserver`, `oracle` o `sqlite`. |
| *Timeout* o error de red al consultar | Sin VPN, host o puerto incorrectos, o firewall. | Revisar la VPN, `HOST` y `PORT`. Las demás conexiones siguen funcionando. |
| *Password authentication failed* | Contraseña incorrecta o con comillas de más. | Revisar el `.env` y usar comillas simples. |
| `READONLY_VIOLATION` | Intento de escritura en una conexión de solo lectura. | Es lo esperado. En QA, si se necesita, `READONLY=false`. |
| Hiciste un cambio en el `.env` y no se nota | El servidor sigue con la configuración anterior. | Reconectar con `/mcp`. |
| `process.loadEnvFile is not a function` | Node anterior a la 20.12. | Actualizar Node. |

---

**Referencias:** [DBHub](https://dbhub.ai) · [Model Context Protocol](https://modelcontextprotocol.io) · [MCP en Claude Code](https://docs.claude.com/en/docs/claude-code/mcp)
