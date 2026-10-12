/**
 * The e2e sandbox data directory.
 *
 * The suite launches the debug binary with `AGENTGAUGE_DATA_DIR` pointed here,
 * so every boot — JSON import source, SQLite database, storage footprint —
 * reads and writes inside a disposable directory instead of the real
 * `~/Library/Application Support` profile. A crashed run can therefore never
 * reset the user's actual onboarding state; that was the cold-start bug.
 *
 * `wdio.conf.ts` wipes and exports it before the app spawns; the fixtures
 * import the same constant so the seeds land where the app will read them.
 */

import os from "node:os";
import path from "node:path";

/** Where this run's app instance keeps its state. */
export const E2E_DATA_DIR = path.join(os.tmpdir(), "agentgauge-e2e-data");
