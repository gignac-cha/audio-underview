import { execSync } from 'node:child_process';

const onePasswordReferencePath =
  process.env.OP_SERVICE_ACCOUNT_REFERENCE ?? 'op://Personal/Service Account Token/credential';

try {
  const token = execSync(`op read "${onePasswordReferencePath}"`, {
    encoding: 'utf-8',
  }).trim();

  process.stdout.write(token);
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
