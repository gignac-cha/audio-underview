import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const executeCommandPromise = promisify(execFile);

const onePasswordReferencePath =
  process.env.OP_SERVICE_ACCOUNT_REFERENCE ??
  'op://Personal/Service Account - Audio Underview/credential';

try {
  const { stdout } = await executeCommandPromise('op', ['read', onePasswordReferencePath], {
    timeout: 10_000,
  });
  process.stdout.write(stdout.trim());
} catch (error) {
  const typedError = error as NodeJS.ErrnoException;
  const message = typedError.message ?? '';

  if (typedError.code === 'ENOENT') {
    console.error('1Password CLI (op) is not installed. Install it from https://1password.com/downloads/command-line/');
  } else if (message.includes('not signed in') || message.includes('sign in')) {
    console.error('Not signed in to 1Password. Run `eval $(op signin)` first.');
  } else {
    console.error('Failed to read service account token from 1Password:', message);
  }

  process.exit(1);
}
