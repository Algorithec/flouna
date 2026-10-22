// Runs before each test file — must set env before src/config/env.ts loads.
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "file:./test.db";
process.env.JWT_ACCESS_SECRET = "test-access-secret-0123456789abcdef0123456789";
process.env.JWT_REFRESH_SECRET = "test-refresh-secret-0123456789abcdef012345678";
process.env.WEB_ORIGIN = "http://localhost:3000";
// Evidence uploads go to a throwaway dir — a test run must never leave files
// in the working tree (they were landing in server/uploads/ before this).
process.env.UPLOAD_DIR = path.join(os.tmpdir(), "flouna-test-uploads");
process.env.LLM_PROVIDER = "demo";
// Secret only (no APP_ID): webhook signature verification is active while
// checkout stays in simulated mode.
process.env.CASHFREE_SECRET_KEY = "test-cashfree-secret";
// Every ONDC food confirm carries our GSTIN. State code 00 does not exist, so
// this can never be a real company's number.
process.env.ONDC_BAP_GSTIN = "00ALGTH0000A1Z0";
