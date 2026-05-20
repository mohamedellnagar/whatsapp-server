import mysql from "mysql2/promise";
import type { RowDataPacket } from "mysql2";

let pool: mysql.Pool | null = null;

function getPool(): mysql.Pool {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST || "localhost",
      port: parseInt(process.env.DB_PORT || "3306"),
      user: process.env.DB_USER || process.env.MYSQL_USER || "root",
      password: process.env.DB_PASSWORD || process.env.MYSQL_PASSWORD || "",
      database: process.env.DB_NAME || process.env.MYSQL_DATABASE || "whatsapp_dashboard",
      waitForConnections: true,
      connectionLimit: 10,
      connectTimeout: 30000,
    });
  }
  return pool;
}

function parse(raw: string): any {
  try { return JSON.parse(raw); } catch { return raw; }
}

export async function initDB(): Promise<void> {
  const dbName = process.env.DB_NAME || "whatsapp_dashboard";

  // Connect without database to create it if needed
  const tempConn = await mysql.createConnection({
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "3306"),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
  });
  await tempConn.execute(
    `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await tempConn.end();

  // Now create the table via the pool
  const db = getPool();
  await db.execute(`
    CREATE TABLE IF NOT EXISTS kv_store (
      \`key\` VARCHAR(512) NOT NULL PRIMARY KEY,
      \`value\` LONGTEXT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

export const set = async (key: string, value: any): Promise<void> => {
  const db = getPool();
  await db.execute(
    "INSERT INTO kv_store (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = ?",
    [key, JSON.stringify(value), JSON.stringify(value)]
  );
};

export const get = async (key: string): Promise<any> => {
  const db = getPool();
  const [rows] = await db.execute<RowDataPacket[]>(
    "SELECT `value` FROM kv_store WHERE `key` = ?",
    [key]
  );
  if (!rows.length) return undefined;
  return parse(rows[0].value);
};

export const del = async (key: string): Promise<void> => {
  const db = getPool();
  await db.execute("DELETE FROM kv_store WHERE `key` = ?", [key]);
};

export const mset = async (keys: string[], values: any[]): Promise<void> => {
  if (!keys.length) return;
  const db = getPool();
  const placeholders = keys.map(() => "(?, ?)").join(", ");
  const params: any[] = [];
  for (let i = 0; i < keys.length; i++) {
    params.push(keys[i], JSON.stringify(values[i]));
  }
  await db.execute(
    `INSERT INTO kv_store (\`key\`, \`value\`) VALUES ${placeholders}
     ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`)`,
    params
  );
};

export const mget = async (keys: string[]): Promise<any[]> => {
  if (!keys.length) return [];
  const db = getPool();
  const placeholders = keys.map(() => "?").join(", ");
  const [rows] = await db.execute<RowDataPacket[]>(
    `SELECT \`key\`, \`value\` FROM kv_store WHERE \`key\` IN (${placeholders})`,
    keys
  );
  const map = new Map<string, any>();
  for (const row of rows) map.set(row.key, parse(row.value));
  return keys.map((k) => map.get(k));
};

export const mdel = async (keys: string[]): Promise<void> => {
  if (!keys.length) return;
  const db = getPool();
  const placeholders = keys.map(() => "?").join(", ");
  await db.execute(
    `DELETE FROM kv_store WHERE \`key\` IN (${placeholders})`,
    keys
  );
};

export const getByPrefix = async (prefix: string): Promise<any[]> => {
  const db = getPool();
  const [rows] = await db.execute<RowDataPacket[]>(
    "SELECT `value` FROM kv_store WHERE `key` LIKE ?",
    [prefix.replace(/[%_\\]/g, "\\$&") + "%"]
  );
  return rows.map((r) => parse(r.value));
};
