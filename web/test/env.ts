// Imported first by every test so the root .env is loaded before lib modules read it.
import path from "node:path";
import { loadEnvConfig } from "@next/env";

loadEnvConfig(path.resolve(import.meta.dirname, "../.."));
