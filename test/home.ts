// a stage folder of the test file's own, set before any server module reads it
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.STAGE_DIR = mkdtempSync(join(tmpdir(), 'stage-test-'));
