import "dotenv/config";
import bcrypt from "bcryptjs";
import { initDB } from "./src/kv_store.js";
import * as kv from "./src/kv_store.js";
import { randomUUID } from "crypto";

const USERNAME = process.argv[2] || "admin";
const PASSWORD = process.argv[3] || "Admin@1234";

await initDB();

const users = await kv.getByPrefix("auth_user:") as any[];
const existing = users.find((u) => u.username === USERNAME);
const hash = await bcrypt.hash(PASSWORD, 10);

if (existing) {
  await kv.set(`auth_user:${existing.id}`, { ...existing, passwordHash: hash });
  console.log(`✅ Password updated for: ${USERNAME}`);
} else {
  const id = randomUUID();
  await kv.set(`auth_user:${id}`, {
    id, username: USERNAME, passwordHash: hash,
    role: "admin", createdAt: new Date().toISOString(),
  });
  console.log(`✅ User created: ${USERNAME}`);
}

console.log(`🔑 Password: ${PASSWORD}`);
process.exit(0);
