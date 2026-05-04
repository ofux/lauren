import readline from 'node:readline';

export function confirm(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(`${prompt} [y/N] `, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a === 'y' || a === 'yes');
    });
    rl.on('close', () => resolve(false));
    rl.on('SIGINT', () => {
      process.stdout.write('\n');
      rl.close();
      resolve(false);
    });
  });
}
