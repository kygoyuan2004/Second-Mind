import fs from 'node:fs';
import os from 'node:os';

// Darwin commonly exposes its temporary root through /var even though the
// canonical path begins with /private/var. Security tests intentionally compare
// lexical and canonical paths, so make only the test sandbox root canonical.
const canonicalTempRoot = fs.realpathSync.native(os.tmpdir());
for (const name of ['TMPDIR', 'TMP', 'TEMP']) process.env[name] = canonicalTempRoot;
