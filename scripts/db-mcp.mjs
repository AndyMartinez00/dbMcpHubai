#!/usr/bin/env node
/**
 * Lanzador del servidor MCP de bases de datos.
 *
 * Lee las conexiones del archivo .env (prefijo CONN_<NOMBRE>_*), genera una
 * configuración TOML para DBHub (https://dbhub.ai) y lo arranca por stdio.
 * DBHub soporta PostgreSQL, MySQL, MariaDB, SQL Server, Oracle y SQLite.
 *
 * Uso:
 *   node scripts/db-mcp.mjs                 -> todas las conexiones del .env
 *   node scripts/db-mcp.mjs QA_VENTAS PR_X  -> solo las conexiones indicadas
 *   node scripts/db-mcp.mjs --list          -> muestra las conexiones (sin secretos) y sale
 *
 * Las contraseñas NO se escriben en disco: el TOML generado solo contiene
 * referencias ${CONN_<NOMBRE>_PASSWORD} que DBHub resuelve desde el entorno.
 *
 * IMPORTANTE: stdout es el canal del protocolo MCP; los mensajes van a stderr.
 */
import { existsSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = process.env.DB_MCP_ENV_FILE || join(ROOT, '.env');
const DBHUB_ENTRY = join(ROOT, 'node_modules', '@bytebase', 'dbhub', 'dist', 'index.js');
const PREFIX = 'CONN_';

const DEFAULT_PORTS = { postgres: 5432, mysql: 3306, mariadb: 3306, sqlserver: 1433, oracle: 1521, sqlite: null };

const fail = (msg) => { console.error(`[db-mcp] ERROR: ${msg}`); process.exit(1); };
const log = (msg) => console.error(`[db-mcp] ${msg}`);
const toml = (v) => JSON.stringify(String(v)); // las cadenas JSON son cadenas básicas TOML válidas
const bool = (v, def) => (v === undefined || v === '' ? def : /^(1|true|yes|si|sí)$/i.test(v));

// ---------------------------------------------------------------- .env
if (!existsSync(ENV_FILE)) fail(`No existe ${ENV_FILE}. Copia .env.example a .env y completa las conexiones.`);
process.loadEnvFile(ENV_FILE);

const args = process.argv.slice(2);
const listOnly = args.includes('--list');
const wanted = args.filter((a) => !a.startsWith('--')).map((a) => a.toUpperCase());

const allNames = Object.keys(process.env)
  .filter((k) => k.startsWith(PREFIX) && k.endsWith('_TYPE'))
  .map((k) => k.slice(PREFIX.length, -'_TYPE'.length))
  .sort();

const unknown = wanted.filter((n) => !allNames.includes(n));
if (unknown.length) fail(`Conexiones no definidas en .env: ${unknown.join(', ')}. Disponibles: ${allNames.join(', ') || '(ninguna)'}`);

const names = wanted.length ? wanted : allNames;
if (!names.length) fail(`No hay conexiones en ${ENV_FILE}. Define al menos CONN_<NOMBRE>_TYPE (ver .env.example).`);

// ---------------------------------------------------------------- conexiones
const connections = names.map((name) => {
  const get = (field) => {
    const v = process.env[`${PREFIX}${name}_${field}`];
    return v === undefined || v.trim() === '' ? undefined : v.trim();
  };
  const type = (get('TYPE') || '').toLowerCase();
  if (!(type in DEFAULT_PORTS)) fail(`${name}: TYPE "${type}" no soportado. Usa: ${Object.keys(DEFAULT_PORTS).join(', ')}`);

  const c = {
    name,
    id: name.toLowerCase(),
    type,
    host: get('HOST'),
    port: get('PORT') ? Number(get('PORT')) : DEFAULT_PORTS[type],
    database: get('DATABASE'),
    user: get('USER'),
    hasPassword: get('PASSWORD') !== undefined,
    passwordVar: `${PREFIX}${name}_PASSWORD`,
    readonly: bool(get('READONLY'), true), // por seguridad, solo lectura salvo que se diga lo contrario
    maxRows: get('MAX_ROWS') ? Number(get('MAX_ROWS')) : 1000,
    description: get('DESCRIPTION'),
    sslmode: get('SSLMODE'),           // PostgreSQL: disable | require | verify-ca | verify-full
    instanceName: get('INSTANCE'),     // SQL Server: instancia con nombre
  };

  if (!c.database) fail(`${name}: falta ${PREFIX}${name}_DATABASE`);
  if (type !== 'sqlite') {
    if (!c.host) fail(`${name}: falta ${PREFIX}${name}_HOST`);
    if (!c.user) fail(`${name}: falta ${PREFIX}${name}_USER`);
    if (!Number.isInteger(c.port)) fail(`${name}: PORT inválido`);
    if (!c.hasPassword) log(`AVISO ${name}: sin ${c.passwordVar}; se intentará conectar sin contraseña.`);
  }
  if (!Number.isInteger(c.maxRows) || c.maxRows <= 0) fail(`${name}: MAX_ROWS inválido`);
  return c;
});

if (listOnly) {
  for (const c of connections) {
    const where = c.type === 'sqlite' ? c.database : `${c.user}@${c.host}:${c.port}/${c.database}`;
    console.log(`${c.name.padEnd(24)} ${c.type.padEnd(10)} ${c.readonly ? 'solo-lectura' : 'LECTURA/ESCRITURA'}  ${where}`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------- TOML para DBHub
const lines = [];
for (const c of connections) {
  lines.push('[[sources]]', `id = ${toml(c.id)}`);
  if (c.description) lines.push(`description = ${toml(c.description)}`);
  lines.push(`type = ${toml(c.type)}`);
  if (c.type !== 'sqlite') {
    lines.push(`host = ${toml(c.host)}`, `port = ${c.port}`, `user = ${toml(c.user)}`);
    if (c.hasPassword) lines.push(`password = "\${${c.passwordVar}}"`);
  }
  lines.push(`database = ${toml(c.database)}`);
  lines.push('lazy = true'); // no conecta hasta el primer uso: una base caída/sin VPN no bloquea al resto
  if (c.sslmode) lines.push(`sslmode = ${toml(c.sslmode)}`);
  if (c.instanceName) lines.push(`instanceName = ${toml(c.instanceName)}`);
  lines.push('');
  lines.push('[[tools]]', 'name = "execute_sql"', `source = ${toml(c.id)}`, `readonly = ${c.readonly}`, `max_rows = ${c.maxRows}`, '');
  lines.push('[[tools]]', 'name = "search_objects"', `source = ${toml(c.id)}`, '');
}

if (!existsSync(DBHUB_ENTRY)) fail(`DBHub no está instalado. Ejecuta "npm install" en ${ROOT}`);

const dir = mkdtempSync(join(tmpdir(), 'db-mcp-'));
const configPath = join(dir, 'dbhub.toml');
writeFileSync(configPath, lines.join('\n'), { mode: 0o600 });
const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignorar */ } };

log(`Conexiones: ${connections.map((c) => `${c.id}(${c.type}${c.readonly ? ', ro' : ', rw'})`).join(' ')}`);

// ---------------------------------------------------------------- arrancar DBHub
const child = spawn(process.execPath, [DBHUB_ENTRY, '--transport', 'stdio', '--config', configPath], {
  cwd: ROOT,
  env: process.env,
  stdio: 'inherit',
});

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => child.kill(sig));
}
child.on('error', (err) => { cleanup(); fail(`No se pudo iniciar DBHub: ${err.message}`); });
child.on('exit', (code, signal) => {
  cleanup();
  process.exit(code ?? (signal ? 1 : 0));
});
